import test from "tape";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fromOb2, ob2ToCurlArgs } from "../src/ob2.ts";

const sample = `BLOCK:HttpRequest
  url = "https://example.com/path?x=1"
  method = POST
  httpLibrary = CurlImpersonate
  curlImpersonateBrowserProfile = Safari260Ios
  customCookies = {("session", "a=b")}
  customHeaders = {("Accept", "application/json"), ("X-Label", "hello")}
  TYPE:STANDARD
  $"{\\"ok\\":true}"
  "application/json"
ENDBLOCK`;

test("OB2 HttpRequest literal fields become cURL argv", (t) => {
  t.deepEqual(ob2ToCurlArgs(sample), [
    "curl",
    "--request",
    "POST",
    "https://example.com/path?x=1",
    "--header",
    "Accept: application/json",
    "--header",
    "X-Label: hello",
    "--header",
    "Content-Type: application/json",
    "--header",
    "Cookie: session=a=b",
    "--data-raw",
    '{"ok":true}',
  ]);
  t.end();
});

test("OB2 accepts headers and cookies split across lines", (t) => {
  const multiline = sample
    .replace(
      '  customHeaders = {("Accept", "application/json"), ("X-Label", "hello")}',
      '  customHeaders = {\n    ("Accept", "application/json"),\n    ("X-Label", "hello")\n  }',
    )
    .replace(
      '  customCookies = {("session", "a=b")}',
      '  customCookies = {\n    ("session", "a=b")\n  }',
    );
  t.deepEqual(ob2ToCurlArgs(multiline), ob2ToCurlArgs(sample));
  t.end();
});

test("OB2 interpolation emits blank variables for each target", (t) => {
  const block = sample
    .replace("customHeaders = {", "customHeaders = ${")
    .replace('"X-Label", "hello"', '"X-Label", "<input.TAG>"')
    .replace(/^  \$".*"$/m, '  $"account=<input.USER>&code=<input.PASS>"');
  t.deepEqual(
    ob2ToCurlArgs(sample.replace("customHeaders = {", "customHeaders = ${")),
    ob2ToCurlArgs(sample),
  );
  const python = fromOb2(block, "python");
  t.ok(python.includes('input_user = ""'));
  t.ok(python.includes('input_pass = ""'));
  t.ok(python.includes('input_tag = ""'));
  t.ok(python.includes("input_user +"));
  const httpx = fromOb2(block, "python-httpx");
  t.ok(httpx.includes("import httpx"));
  t.ok(httpx.includes("content="));
  const go = fromOb2(block, "go");
  t.ok(go.includes('inputUser := ""'));
  t.ok(go.includes("strings.NewReader("));
  t.throws(() => fromOb2(block, "curl"), /cannot be represented/);
  t.end();
});

test("OB2 block can target standard request backends", (t) => {
  const python = fromOb2(sample, "python");
  t.ok(python.includes("import requests"));
  t.ok(python.includes("example.com"));
  const httpx = fromOb2(sample, "python-httpx");
  t.ok(httpx.includes("import httpx"));
  t.ok(httpx.includes("content="));
  const go = fromOb2(sample, "go");
  t.ok(go.includes("package main"));
  t.ok(go.includes("net/http"));
  t.ok(fromOb2(sample, "curl").includes("--data-raw"));
  t.ok(httpx.includes("transport profile omitted"));
  t.end();
});

test("OB2 parser rejects unknown fields and multiple blocks", (t) => {
  t.throws(
    () =>
      ob2ToCurlArgs(
        sample.replace("  method = POST", "  method = POST\n  proxy = true"),
      ),
    /Unsupported OB2 field/,
  );
  const urlVariable = fromOb2(
    sample.replace("example.com", "<HOST>"),
    "python-httpx",
  );
  t.ok(urlVariable.includes('host = ""'));
  t.throws(
    () => ob2ToCurlArgs(sample + "\nBLOCK:HttpRequest"),
    /Expected one OB2/,
  );
  t.end();
});

test("OB2 CLI accepts a multiline block on stdin without a dash", (t) => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [cli, "--input", "ob2", "--language", "python-httpx"],
    { input: sample, encoding: "utf8" },
  );
  t.equal(result.status, 0, result.stderr);
  t.ok(result.stdout.includes("import httpx"));
  t.ok(result.stdout.includes("example.com/path?x=1"));
  t.end();
});

test("OB2 preserves explicit Cookie and HTTP options", (t) => {
  const block = sample
    .replace(
      "  method = POST",
      [
        "  method = POST",
        "  autoRedirect = False",
        "  urlEncodeContent = True",
        "  curlUseBrowserHeaders = False",
        "  ignoreCertificateValidation = False",
        '  httpVersion = "2.0"',
      ].join("\n"),
    )
    .replace('("X-Label", "hello")', '("Cookie", "<out1>")')
    .replace(/^  \$".*"$/m, '  $"name=<input.USER>&code=<input.PASS>"');
  const args = ob2ToCurlArgs(block);
  t.ok(args.includes("Cookie: <out1>"));
  t.notOk(args.some((arg) => arg.includes("session=a=b")));
  const httpx = fromOb2(block, "python-httpx");
  t.ok(httpx.includes("http2=True"));
  t.ok(httpx.includes("verify=False") === false);
  t.ok(httpx.includes("quote("));
  t.ok(httpx.includes("out1 ="));
  const cffi = fromOb2(block, "python-curl-cffi");
  t.ok(cffi.includes("impersonate='safari260_ios'"));
  t.ok(cffi.includes("default_headers=False"));
  t.ok(cffi.includes("http_version='v2'"));
  t.ok(cffi.includes("verify=True"));
  t.ok(cffi.includes("allow_redirects=False"));
  const go = fromOb2(block, "go");
  t.ok(go.includes("http.ErrUseLastResponse"));
  t.ok(go.includes("url.QueryEscape("));
  t.ok(go.includes("ForceAttemptHTTP2: true"));
  t.throws(() => fromOb2(block, "python"), /cannot force HTTP\/2/);
  t.throws(() => fromOb2(block, "curl"), /cannot be represented/);
  t.end();
});

test("OB2 URL encoding handles literal bodies and checks booleans", (t) => {
  const block = sample
    .replace("  method = POST", "  method = POST\n  urlEncodeContent = True")
    .replace(/^  \$".*"$/m, '  $"name=hello world&code=1"');
  t.ok(ob2ToCurlArgs(block).includes("name=hello%20world&code=1"));
  t.ok(
    ob2ToCurlArgs(block.replace("hello world", "it\'s fine")).includes(
      "name=it%27s%20fine&code=1",
    ),
  );
  t.throws(
    () =>
      ob2ToCurlArgs(
        sample.replace(
          "  method = POST",
          "  method = POST\n  autoRedirect = Maybe",
        ),
      ),
    /must be True or False/,
  );
  t.end();
});
