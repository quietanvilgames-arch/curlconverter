from curl_cffi import requests

headers = [
    ('foo', 'bar'),
]

with requests.Session() as client:
    response = client.request(
        'GET',
        'http://localhost:28139/',
        allow_redirects=False,
        timeout=None,
        headers=headers,
    )
print(response.text)
