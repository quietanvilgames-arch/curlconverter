import { CCError } from "./utils.ts";
import { reprStr } from "./generators/python/python.ts";

type Output = "python" | "python-httpx" | "go";
type TemplateVariable = { source: string; python: string; go: string };

const marker = /<([A-Za-z_][A-Za-z0-9_.]*)>/g;

function variables(values: string[]): TemplateVariable[] {
  const seen = new Set<string>();
  const names = new Set<string>();
  const result: TemplateVariable[] = [];
  for (const value of values) {
    for (const match of value.matchAll(marker)) {
      const source = match[1];
      if (seen.has(source)) continue;
      seen.add(source);
      const parts = source
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .split(/[._]+/)
        .filter(Boolean)
        .map((part) => part.toLowerCase());
      const base = parts.join("_");
      let python = base;
      for (let suffix = 2; names.has(python); suffix++)
        python = base + "_" + suffix;
      names.add(python);
      result.push({
        source,
        python,
        go: python.replace(/_([a-z0-9])/g, (_, part: string) =>
          part.toUpperCase(),
        ),
      });
    }
  }
  return result;
}

function template(
  value: string,
  names: Map<string, string>,
  literal: (value: string) => string,
): string {
  const pieces: string[] = [];
  let offset = 0;
  for (const match of value.matchAll(marker)) {
    if (match.index > offset)
      pieces.push(literal(value.slice(offset, match.index)));
    const name = names.get(match[1]);
    if (!name) throw new CCError("Missing OB2 variable: " + match[1]);
    pieces.push(name);
    offset = match.index + match[0].length;
  }
  if (offset < value.length || !pieces.length)
    pieces.push(literal(value.slice(offset)));
  return pieces.join(" + ");
}

function fields(args: string[]) {
  const headers: [string, string][] = [];
  let body: string | undefined;
  for (let i = 4; i < args.length; i += 2) {
    if (args[i] === "--header") {
      const line = args[i + 1];
      const colon = line.indexOf(":");
      headers.push([line.slice(0, colon), line.slice(colon + 2)]);
    } else if (args[i] === "--data-raw") {
      body = args[i + 1];
    } else {
      throw new CCError("Unsupported OB2 cURL argument: " + args[i]);
    }
  }
  return { method: args[2], url: args[3], headers, body };
}

export function renderOb2Dynamic(
  args: string[],
  output: Output,
): string | null {
  const request = fields(args);
  const vars = variables([
    request.url,
    ...request.headers.flatMap(([name, value]) => [name, value]),
    request.body ?? "",
  ]);
  if (!vars.length) return null;

  const pyNames = new Map(vars.map((v) => [v.source, v.python]));
  const goNames = new Map(vars.map((v) => [v.source, v.go]));
  const py = (value: string) => template(value, pyNames, reprStr);
  const go = (value: string) => template(value, goNames, JSON.stringify);

  if (output === "python" || output === "python-httpx") {
    const httpx = output === "python-httpx";
    let code = "import " + (httpx ? "httpx" : "requests") + "\n\n";
    code += vars.map((v) => v.python + ' = ""\n').join("") + "\n";
    if (request.headers.length) {
      code += httpx ? "headers = [\n" : "headers = {\n";
      for (const [name, value] of request.headers) {
        code += httpx
          ? "    (" + py(name) + ", " + py(value) + "),\n"
          : "    " + py(name) + ": " + py(value) + ",\n";
      }
      code += httpx ? "]\n\n" : "}\n\n";
    }
    if (httpx) {
      code +=
        "with httpx.Client(timeout=None, follow_redirects=False) as client:\n";
      code += "    response = client.request(\n";
      code += "        " + reprStr(request.method) + ",\n";
      code += "        " + py(request.url) + ",\n";
      if (request.headers.length) code += "        headers=headers,\n";
      if (request.body !== undefined)
        code += "        content=" + py(request.body) + ",\n";
      code += "    )\n";
    } else {
      code += "response = requests.request(\n";
      code += "    " + reprStr(request.method) + ",\n";
      code += "    " + py(request.url) + ",\n";
      if (request.headers.length) code += "    headers=headers,\n";
      if (request.body !== undefined)
        code += "    data=" + py(request.body) + ",\n";
      code += ")\n";
    }
    return code + "print(response.text)\n";
  }

  let code =
    'package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"log"\n\t"net/http"\n';
  if (request.body !== undefined) code += '\t"strings"\n';
  code += ")\n\nfunc main() {\n";
  for (const v of vars) code += "\t" + v.go + ' := ""\n';
  code += "\n";
  if (request.body !== undefined) {
    code += "\tbody := strings.NewReader(" + go(request.body) + ")\n";
  }
  code +=
    "\treq, err := http.NewRequest(" + JSON.stringify(request.method) + ", ";
  code +=
    go(request.url) +
    ", " +
    (request.body === undefined ? "nil" : "body") +
    ")\n";
  code += "\tif err != nil { log.Fatal(err) }\n";
  for (const [name, value] of request.headers) {
    code += "\treq.Header.Add(" + go(name) + ", " + go(value) + ")\n";
  }
  code += "\tresp, err := (&http.Client{}).Do(req)\n";
  code += "\tif err != nil { log.Fatal(err) }\n";
  code += "\tdefer resp.Body.Close()\n";
  code += "\tresponseBody, err := io.ReadAll(resp.Body)\n";
  code += "\tif err != nil { log.Fatal(err) }\n";
  code += '\tfmt.Printf("%s\\n", responseBody)\n}\n';
  return code;
}
