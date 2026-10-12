from curl_cffi import requests

headers = [
    ('X-Api-Key', '123456789'),
]

with requests.Session() as client:
    response = client.request(
        'GET',
        'http://localhost:28139/synthetics/api/v3/monitors?test=2&limit=100&w=4',
        allow_redirects=False,
        timeout=None,
        headers=headers,
    )
print(response.text)
