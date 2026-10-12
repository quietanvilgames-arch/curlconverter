import httpx

headers = [
    ('foo', 'bar'),
]

with httpx.Client(timeout=None, follow_redirects=False) as client:
    response = client.request(
        'GET',
        'http://localhost:28139/',
        headers=headers,
    )
print(response.text)
