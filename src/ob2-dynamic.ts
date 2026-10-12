import { CCError } from "./utils.ts";
import { reprStr } from "./generators/python/python.ts";
import type { Ob2Settings } from "./ob2.ts";

type Output = "python" | "python-httpx" | "python-curl-cffi" | "go";
type TemplateVariable = { source: string; python: string; go: string };

const marker = /<([A-Za-z_][A-Za-z0-9_.]*)>/g;

const browserProfiles: Record<string, string> = {
  Chrome99: "chrome99",
  Chrome100: "chrome100",
  Chrome101: "chrome101",
  Chrome104: "chrome104",
  Chrome107: "chrome107",
  Chrome110: "chrome110",
  Chrome116: "chrome116",
  Chrome119: "chrome119",
  Chrome120: "chrome120",
  Chrome123: "chrome123",
  Chrome124: "chrome124",
  Chrome131: "chrome131",
  Chrome133a: "chrome133a",
  Chrome136: "chrome136",
  Chrome142: "chrome142",
  Chrome145: "chrome145",
  Chrome146: "chrome146",
  Chrome99Android: "chrome99_android",
  Chrome131Android: "chrome131_android",
  Edge99: "edge99",
  Edge101: "edge101",
  Safari153: "safari153",
  Safari155: "safari155",
  Safari170: "safari170",
  Safari172Ios: "safari172_ios",
  Safari180: "safari180",
  Safari180Ios: "safari180_ios",
  Safari184: "safari184",
  Safari184Ios: "safari184_ios",
  Safari260: "safari260",
  Safari260Ios: "safari260_ios",
  Firefox133: "firefox133",
  Firefox135: "firefox135",
  Firefox144: "firefox144",
  Firefox147: "firefox147",
  Tor145: "tor145",
};

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
  settings: Ob2Settings = {},
  force = false,
): string | null {
  const request = fields(args);
  const vars = variables([
    request.url,
    ...request.headers.flatMap(([name, value]) => [name, value]),
    request.body ?? "",
  ]);
  if (!vars.length && !force) return null;

  const pyNames = new Map(vars.map((v) => [v.source, v.python]));
  const goNames = new Map(vars.map((v) => [v.source, v.go]));
  const py = (value: string) => template(value, pyNames, reprStr);
  const go = (value: string) => template(value, goNames, JSON.stringify);

  if (output !== "go") {
    const httpx = output === "python-httpx";
    const cffi = output === "python-curl-cffi";
    let code = cffi
      ? "from curl_cffi import requests\n"
      : "import " + (httpx ? "httpx" : "requests") + "\n";
    const encodeBody =
      settings.urlEncodeContent === true &&
      request.body !== undefined &&
      /<[A-Za-z_][A-Za-z0-9_.]*>/.test(request.body);
    if (encodeBody) code += "from urllib.parse import quote\n";
    code += "\n";
    code += vars.map((v) => v.python + ' = ""\n').join("") + "\n";
    if (request.headers.length) {
      code += httpx || cffi ? "headers = [\n" : "headers = {\n";
      for (const [name, value] of request.headers) {
        code +=
          httpx || cffi
            ? "    (" + py(name) + ", " + py(value) + "),\n"
            : "    " + py(name) + ": " + py(value) + ",\n";
      }
      code += httpx || cffi ? "]\n\n" : "}\n\n";
    }
    const rawBody = request.body === undefined ? "" : py(request.body);
    const body = encodeBody
      ? "quote(" +
        rawBody +
        ', safe="").replace("%26", "&").replace("%3D", "=")'
      : rawBody;
    if (httpx || cffi) {
      if (httpx) {
        code +=
          "with httpx.Client(timeout=None, follow_redirects=" +
          (settings.autoRedirect === true ? "True" : "False") +
          (settings.httpVersion === "2.0" ? ", http2=True" : "") +
          (settings.ignoreCertificateValidation === true
            ? ", verify=False"
            : "") +
          ") as client:\n";
      } else {
        code += "with requests.Session() as client:\n";
      }
      code += "    response = client.request(\n";
      code += "        " + reprStr(request.method) + ",\n";
      code += "        " + py(request.url) + ",\n";
      if (request.headers.length) code += "        headers=headers,\n";
      if (request.body !== undefined) code += "        content=" + body + ",\n";
      if (cffi) {
        code +=
          "        allow_redirects=" +
          (settings.autoRedirect === true ? "True" : "False") +
          ",\n";
        if (settings.ignoreCertificateValidation !== undefined)
          code +=
            "        verify=" +
            (settings.ignoreCertificateValidation ? "False" : "True") +
            ",\n";
        if (settings.httpVersion)
          code +=
            "        http_version=" +
            reprStr(
              settings.httpVersion === "3.0"
                ? "v3"
                : settings.httpVersion === "2.0"
                  ? "v2"
                  : "v1",
            ) +
            ",\n";
        if (settings.httpLibrary === "CurlImpersonate") {
          const profile = settings.curlImpersonateBrowserProfile;
          const target = profile && browserProfiles[profile];
          if (!target)
            throw new CCError("Unsupported curl_cffi browser profile: " + profile);
          code += "        impersonate=" + reprStr(target) + ",\n";
          if (settings.curlUseBrowserHeaders !== undefined)
            code +=
              "        default_headers=" +
              (settings.curlUseBrowserHeaders ? "True" : "False") +
              ",\n";
        }
      }
      code += "    )\n";
    } else {
      code += "response = requests.request(\n";
      code += "    " + reprStr(request.method) + ",\n";
      code += "    " + py(request.url) + ",\n";
      if (request.headers.length) code += "    headers=headers,\n";
      if (request.body !== undefined) code += "    data=" + body + ",\n";
      if (settings.autoRedirect !== undefined)
        code +=
          "    allow_redirects=" +
          (settings.autoRedirect ? "True" : "False") +
          ",\n";
      if (settings.ignoreCertificateValidation !== undefined)
        code +=
          "    verify=" +
          (settings.ignoreCertificateValidation ? "False" : "True") +
          ",\n";
      code += ")\n";
    }
    return code + "print(response.text)\n";
  }

  let code =
    'package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"log"\n\t"net/http"\n';
  if (request.body !== undefined) code += '\t"strings"\n';
  if (settings.ignoreCertificateValidation === true) code += '\t"crypto/tls"\n';
  if (
    settings.urlEncodeContent === true &&
    request.body !== undefined &&
    /<[A-Za-z_][A-Za-z0-9_.]*>/.test(request.body)
  )
    code += '\t"net/url"\n';
  code += ")\n\nfunc main() {\n";
  for (const v of vars) code += "\t" + v.go + ' := ""\n';
  code += "\n";
  if (request.body !== undefined) {
    let value = go(request.body);
    if (
      settings.urlEncodeContent === true &&
      /<[A-Za-z_][A-Za-z0-9_.]*>/.test(request.body)
    ) {
      value =
        "strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(" +
        value +
        '), "+", "%20"), "%26", "&"), "%3D", "=")';
    }
    code += "\tbody := strings.NewReader(" + value + ")\n";
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
  let client = "&http.Client{}";
  if (
    settings.autoRedirect === false ||
    settings.ignoreCertificateValidation === true ||
    settings.httpVersion === "2.0"
  ) {
    code += "\tclient := &http.Client{}\n";
    if (settings.autoRedirect === false)
      code +=
        "\tclient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }\n";
    if (settings.ignoreCertificateValidation === true)
      code +=
        "\tclient.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ForceAttemptHTTP2: true}\n";
    else if (settings.httpVersion === "2.0")
      code += "\tclient.Transport = &http.Transport{ForceAttemptHTTP2: true}\n";
    client = "client";
  }
  code += "\tresp, err := " + client + ".Do(req)\n";
  code += "\tif err != nil { log.Fatal(err) }\n";
  code += "\tdefer resp.Body.Close()\n";
  code += "\tresponseBody, err := io.ReadAll(resp.Body)\n";
  code += "\tif err != nil { log.Fatal(err) }\n";
  code += '\tfmt.Printf("%s\\n", responseBody)\n}\n';
  return code;
}
