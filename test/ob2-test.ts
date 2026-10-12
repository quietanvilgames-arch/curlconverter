import test from "tape";
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

test("OB2 parser rejects unknown fields and dynamic values", (t) => {
  t.throws(
    () =>
      ob2ToCurlArgs(
        sample.replace("  method = POST", "  method = POST\n  proxy = true"),
      ),
    /Unsupported OB2 field/,
  );
  t.throws(
    () => ob2ToCurlArgs(sample.replace("example.com", "<HOST>")),
    /variables/,
  );
  t.throws(
    () => ob2ToCurlArgs(sample + "\nBLOCK:HttpRequest"),
    /Expected one OB2/,
  );
  t.end();
});
