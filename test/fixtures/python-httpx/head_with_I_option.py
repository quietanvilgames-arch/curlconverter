import httpx

with httpx.Client(timeout=None, follow_redirects=False) as client:
    response = client.request(
        'HEAD',
        'http://localhost:28139/page',
    )
print(response.text)
