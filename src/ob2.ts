import { CCError } from "./utils.ts";
import { toPython } from "./generators/python/python.ts";
import { toPythonHttpx } from "./generators/python/httpx.ts";
import { toGo } from "./generators/go.ts";

export type Ob2Output = "curl" | "python" | "python-httpx" | "go";

type Pair = [string, string];

function quoted(value: string, field: string): string {
  if (!/^"(?:\\.|[^"\\])*"$/.test(value)) {
    throw new CCError("OB2 " + field + " must be a quoted literal");
  }
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded !== "string") {
      throw new Error("not a string");
    }
    if (/<[A-Za-z_][A-Za-z0-9_]*>/.test(decoded)) {
      throw new CCError("OB2 variables in " + field + " are not supported");
    }
    return decoded;
  } catch (e) {
    if (e instanceof CCError) {
      throw e;
    }
    throw new CCError("OB2 " + field + " has an invalid string escape");
  }
}

function pairs(value: string, field: string): Pair[] {
  if (!value.startsWith("{") || !value.endsWith("}")) {
    throw new CCError("OB2 " + field + " must be a tuple list");
  }
  let rest = value.slice(1, -1).trim();
  const output: Pair[] = [];
  while (rest) {
    const match =
      /^\(\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*\)/.exec(
        rest,
      );
    if (!match) {
      throw new CCError("OB2 " + field + " contains an unsupported tuple");
    }
    output.push([quoted(match[1], field), quoted(match[2], field)]);
    rest = rest.slice(match[0].length).trim();
    if (rest) {
      if (!rest.startsWith(",")) {
        throw new CCError("OB2 " + field + " must separate tuples with commas");
      }
      rest = rest.slice(1).trim();
      if (!rest) {
        throw new CCError("OB2 " + field + " has a trailing comma");
      }
    }
  }
  return output;
}

/**
 * Parse one literal OB2 HttpRequest TYPE:STANDARD block into cURL argv.
 * Unknown fields are errors so a conversion cannot silently drop behavior.
 */
export function ob2ToCurlArgs(block: string): string[] {
  const lines = block
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== "BLOCK:HttpRequest" || lines.at(-1) !== "ENDBLOCK") {
    throw new CCError("Expected one OB2 BLOCK:HttpRequest ... ENDBLOCK");
  }

  let url: string | undefined;
  let method = "GET";
  let body: string | undefined;
  let contentType: string | undefined;
  let headers: Pair[] = [];
  let cookies: Pair[] = [];
  const seen = new Set<string>();
  let standard = false;
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line === "TYPE:STANDARD") {
      if (standard || i + 2 !== lines.length - 2) {
        throw new CCError("Expected one TYPE:STANDARD body and content type");
      }
      standard = true;
      if (!lines[i + 1].startsWith('$"')) {
        throw new CCError("Only literal TYPE:STANDARD bodies are supported");
      }
      body = quoted(lines[i + 1].slice(1), "body");
      contentType = quoted(lines[i + 2], "content type");
      break;
    }
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
    if (!match || seen.has(match[1])) {
      throw new CCError("Unsupported or duplicate OB2 field: " + line);
    }
    const [, field, value] = match;
    seen.add(field);
    switch (field) {
      case "url":
        url = quoted(value, field);
        break;
      case "method":
        if (!/^[A-Z]+$/.test(value)) {
          throw new CCError("Only literal HTTP methods are supported");
        }
        method = value;
        break;
      case "customHeaders":
        headers = pairs(value, field);
        break;
      case "customCookies":
        cookies = pairs(value, field);
        break;
      case "httpLibrary":
      case "curlImpersonateBrowserProfile":
        // Transport profiles are not HTTP request data.
        if (!/^[A-Za-z0-9]+$/.test(value)) {
          throw new CCError("Unsupported OB2 transport field: " + line);
        }
        break;
      default:
        throw new CCError("Unsupported OB2 field: " + field);
    }
  }
  if (!standard || !url || body === undefined || contentType === undefined) {
    throw new CCError("OB2 block requires a URL and TYPE:STANDARD");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new CCError("OB2 URL must start with http:// or https://");
  }
  const args = ["curl", "--request", method, url];
  const hasContentType = headers.some(([name]) => name.toLowerCase() === "content-type");
  if (contentType && !hasContentType) {
    headers.push(["Content-Type", contentType]);
  }
  if (cookies.length) {
    if (headers.some(([name]) => name.toLowerCase() === "cookie")) {
      throw new CCError("OB2 block contains both a Cookie header and customCookies");
    }
    headers.push(["Cookie", cookies.map(([key, value]) => key + "=" + value).join("; ")]);
  }
  for (const [name, value] of headers) {
    if (!name || /[:\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new CCError("OB2 header contains invalid characters");
    }
    args.push("--header", name + ": " + value);
  }
  if (body || method !== "GET") {
    args.push("--data-raw", body);
  }
  return args;
}

export function fromOb2(block: string, output: Ob2Output): string {
  const args = ob2ToCurlArgs(block);
  const profile = /^\s*(?:httpLibrary|curlImpersonateBrowserProfile)\s*=/m.test(block);
  const note = profile
    ? (output === "go" ? "//" : "#") +
      " OB2 transport profile omitted; verify network behavior.\n"
    : "";
  switch (output) {
    case "python":
      return note + toPython(args);
    case "python-httpx":
      return note + toPythonHttpx(args);
    case "go":
      return note + toGo(args);
    case "curl":
      return note + args.map((arg) => "'" + arg.replace(/'/g, "'\\''") + "'").join(" ") + "\n";
  }
}
