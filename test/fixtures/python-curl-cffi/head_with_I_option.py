from curl_cffi import requests

with requests.Session() as client:
    response = client.request(
        'HEAD',
        'http://localhost:28139/page',
        allow_redirects=False,
        timeout=None,
    )
print(response.text)
