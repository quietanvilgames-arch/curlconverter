import { CCError } from "./utils.ts";
import { toPython } from "./generators/python/python.ts";
import { toPythonHttpx } from "./generators/python/httpx.ts";
import { toPythonCurlCffi } from "./generators/python/curl_cffi.ts";
import { toGo } from "./generators/go.ts";
import { renderOb2Dynamic } from "./ob2-dynamic.ts";

export type Ob2Output = "curl" | "python" | "python-httpx" | "python-curl-cffi" | "go";

export interface Ob2Settings {
  autoRedirect?: boolean;
  urlEncodeContent?: boolean;
  curlUseBrowserHeaders?: boolean;
  ignoreCertificateValidation?: boolean;
  httpVersion?: string;
  httpLibrary?: string;
  curlImpersonateBrowserProfile?: string;
}

function boolean(value: string, field: string): boolean {
  if (value === "True") return true;
  if (value === "False") return false;
  throw new CCError("OB2 " + field + " must be True or False");
}

function encodeContent(body: string): string {
  return encodeURIComponent(body).replace(/%26/gi, "&").replace(/%3D/gi, "=");
}


type Pair = [string, string];

function quoted(value: string, field: string): string {
  const literal = value.startsWith('$"') ? value.slice(1) : value;
  if (!/^"(?:\\.|[^"\\])*"$/.test(literal)) {
    throw new CCError("OB2 " + field + " must be a quoted literal");
  }
  try {
    const decoded: unknown = JSON.parse(literal);
    if (typeof decoded !== "string") {
      throw new Error("not a string");
    }
    return decoded;
  } catch (e) {
    if (e instanceof CCError) {
      throw e;
    }
    throw new CCError("OB2 " + field + " has an invalid string escape");
  }
}

function tupleListDepth(value: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
    } else if (inString && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString && char === "{") {
      depth++;
    } else if (!inString && char === "}") {
      depth--;
      if (depth < 0) {
        throw new CCError("OB2 tuple list has an extra closing brace");
      }
    }
  }
  return depth;
}

function pairs(value: string, field: string): Pair[] {
  if (!value.startsWith("{") || !value.endsWith("}")) {
    throw new CCError("OB2 " + field + " must be a tuple list");
  }
  let rest = value.slice(1, -1).trim();
  const output: Pair[] = [];
  while (rest) {
    const match =
      /^\(\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*\)/.exec(rest);
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
function parseOb2(block: string): { args: string[]; settings: Ob2Settings } {
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
  const settings: Ob2Settings = {};
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
    const [, field] = match;
    let value = match[2];
    if (
      (field === "customHeaders" || field === "customCookies") &&
      value.startsWith("${")
    ) {
      value = value.slice(1);
    }
    if (
      (field === "customHeaders" || field === "customCookies") &&
      value.startsWith("{")
    ) {
      while (tupleListDepth(value) > 0 && i + 1 < lines.length - 1) {
        value += " " + lines[++i];
      }
      if (tupleListDepth(value) !== 0) {
        throw new CCError("OB2 " + field + " has an unclosed tuple list");
      }
    }
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
      case "autoRedirect":
      case "urlEncodeContent":
      case "curlUseBrowserHeaders":
      case "ignoreCertificateValidation":
        settings[field] = boolean(value, field);
        break;
      case "httpVersion":
        settings.httpVersion = quoted(value, field);
        if (!["1.0", "1.1", "2.0", "3.0"].includes(settings.httpVersion)) {
          throw new CCError("Unsupported OB2 httpVersion: " + settings.httpVersion);
        }
        break;
      case "httpLibrary":
      case "curlImpersonateBrowserProfile":
        if (!/^[A-Za-z0-9]+$/.test(value)) {
          throw new CCError("Unsupported OB2 transport field: " + line);
        }
        settings[field] = value;
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
  const hasContentType = headers.some(
    ([name]) => name.toLowerCase() === "content-type",
  );
  if (contentType && !hasContentType) {
    headers.push(["Content-Type", contentType]);
  }
  if (cookies.length && !headers.some(([name]) => name.toLowerCase() === "cookie")) {
    headers.push([
      "Cookie",
      cookies.map(([key, value]) => key + "=" + value).join("; "),
    ]);
  }
  for (const [name, value] of headers) {
    if (!name || /[:\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new CCError("OB2 header contains invalid characters");
    }
    args.push("--header", name + ": " + value);
  }
  if (body || method !== "GET") {
    args.push("--data-raw", settings.urlEncodeContent && !/<[A-Za-z_][A-Za-z0-9_.]*>/.test(body) ? encodeContent(body) : body);
  }
  return { args, settings };
}

export function ob2ToCurlArgs(block: string): string[] {
  return parseOb2(block).args;
}

export function fromOb2(block: string, output: Ob2Output): string {
  const { args, settings } = parseOb2(block);
  const advanced =
    settings.autoRedirect !== undefined ||
    settings.urlEncodeContent === true ||
    settings.ignoreCertificateValidation !== undefined ||
    settings.httpVersion !== undefined ||
    (output === "python-curl-cffi" && settings.httpLibrary === "CurlImpersonate");
  if (output === "python" && settings.httpVersion === "2.0") {
    throw new CCError("Python requests cannot force HTTP/2");
  }
  if (settings.httpVersion === "3.0" && output !== "python-curl-cffi" && output !== "curl") {
    throw new CCError("This output does not support HTTP/3");
  }
  const dynamic = output === "curl" ? null : renderOb2Dynamic(args, output, settings, advanced);
  if (
    output === "curl" &&
    args.some((arg) => /<[A-Za-z_][A-Za-z0-9_.]*>/.test(arg))
  ) {
    throw new CCError(
      "Dynamic OB2 variables cannot be represented in cURL output yet",
    );
  }
  const profile = /^\s*(?:httpLibrary|curlImpersonateBrowserProfile)\s*=/m.test(
    block,
  );
  const note = profile && output !== "python-curl-cffi"
    ? (output === "go" ? "//" : "#") +
      " OB2 transport profile omitted; verify network behavior.\n"
    : "";
  if (dynamic !== null) return note + dynamic;
  switch (output) {
    case "python":
      return note + toPython(args);
    case "python-httpx":
      return note + toPythonHttpx(args);
    case "python-curl-cffi":
      return note + toPythonCurlCffi(args);
    case "go":
      return note + toGo(args);
    case "curl": {
      const curlArgs = [...args];
      if (settings.autoRedirect === true) curlArgs.push("--location");
      if (settings.ignoreCertificateValidation === true) curlArgs.push("--insecure");
      if (settings.httpVersion) {
        curlArgs.push(
          settings.httpVersion === "2.0" ? "--http2" :
          settings.httpVersion === "3.0" ? "--http3" :
          settings.httpVersion === "1.0" ? "--http1.0" : "--http1.1",
        );
      }
      return (
        note +
        curlArgs.map((arg) => "'" + arg.replace(/'/g, "'\\''") + "'").join(" ") +
        "\n"
      );
    }
  }
}
