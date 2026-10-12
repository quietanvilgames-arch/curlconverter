import httpx

headers = [
    ('X-Api-Key', '123456789'),
]

with httpx.Client(timeout=None, follow_redirects=False) as client:
    response = client.request(
        'GET',
        'http://localhost:28139/synthetics/api/v3/monitors?test=2&limit=100&w=4',
        headers=headers,
    )
print(response.text)
