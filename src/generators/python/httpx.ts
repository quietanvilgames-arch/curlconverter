import { CCError } from "../../utils.ts";
import { parse, getFirst } from "../../parse.ts";
import type { Request, Warnings } from "../../parse.ts";
import { reprStr } from "./python.ts";

// This backend handles one ordinary HTTP request. The parser reports other
// cURL options through the existing warning mechanism.
export const supportedArgs = new Set([
  "url",
  "proto-default",
  "globoff",
  "request",
  "get",
  "head",
  "no-head",
  "header",
  "user-agent",
  "referer",
  "range",
  "cookie",
  "user",
  "basic",
  "no-basic",
  "data",
  "data-raw",
  "data-ascii",
  "data-binary",
  "data-urlencode",
  "json",
  "url-query",
  "location",
  "no-location",
]);

export function _toPythonHttpx(
  requests: Request[],
  warnings: Warnings = [],
): string {
  const request = getFirst(requests, warnings);
  const firstUrl = request.urls[0];

  if (request.multipartUploads || firstUrl.uploadFile || request.dataReadsFile) {
    throw new CCError(
      "HTTPX output does not yet support multipart uploads or file-backed request bodies",
    );
  }
  if (firstUrl.queryReadsFile) {
    throw new CCError("HTTPX output does not yet support file-backed queries");
  }
  if (request.cookieFiles?.length) {
    throw new CCError("HTTPX output does not yet support cookie files");
  }
  if (firstUrl.auth && request.authType !== "basic") {
    throw new CCError("HTTPX output does not yet support this authentication type");
  }
  if (request.followRedirectsTrusted) {
    throw new CCError("HTTPX output does not support --location-trusted");
  }

  const method = firstUrl.method.toString();
  const url = firstUrl.url.toString();
  if (!firstUrl.method.isString() || !firstUrl.url.isString()) {
    warnings.push([
      "dynamic-input",
      "The method or URL contains shell expansion; review the generated string before running it",
    ]);
  }

  const headers = Array.from(request.headers).filter(([, value]) => value !== null);
  let code = "import httpx\n\n";
  if (headers.length) {
    code += "headers = [\n";
    for (const [name, value] of headers) {
      if (!name.isString() || !value?.isString()) {
        warnings.push([
          "dynamic-input",
          "A header contains shell expansion; review the generated string before running it",
        ]);
      }
      code += `    (${reprStr(name.toString())}, ${reprStr(value?.toString() ?? "")}),\n`;
    }
    code += "]\n\n";
  }

  code += `with httpx.Client(timeout=None, follow_redirects=${
    request.followRedirects ? "True" : "False"
  }) as client:\n`;
  code += "    response = client.request(\n";
  code += `        ${reprStr(method)},\n        ${reprStr(url)},\n`;
  if (headers.length) {
    code += "        headers=headers,\n";
  }
  if (request.data !== undefined) {
    if (!request.data.isString()) {
      warnings.push([
        "dynamic-input",
        "The body contains shell expansion; review the generated string before running it",
      ]);
    }
    const body = request.data.toString();
    if (/[^\x00-\x7f]/.test(body)) {
      warnings.push([
        "body-encoding",
        "HTTPX encodes text bodies as UTF-8; verify non-ASCII request bytes",
      ]);
    }
    code += `        content=${reprStr(body)},\n`;
  }
  if (firstUrl.auth) {
    const [user, password] = firstUrl.auth;
    if (!user.isString() || !password.isString()) {
      warnings.push([
        "dynamic-input",
        "Basic authentication contains shell expansion; review the generated strings",
      ]);
    }
    code += `        auth=httpx.BasicAuth(${reprStr(user.toString())}, ${reprStr(password.toString())}),\n`;
  }
  code += "    )\nprint(response.text)\n";
  return code;
}

export function toPythonHttpxWarn(
  curlCommand: string | string[],
  warnings: Warnings = [],
): [string, Warnings] {
  const requests = parse(curlCommand, supportedArgs, warnings);
  return [_toPythonHttpx(requests, warnings), warnings];
}

export function toPythonHttpx(curlCommand: string | string[]): string {
  return toPythonHttpxWarn(curlCommand)[0];
}
