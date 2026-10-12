import httpx

headers = [
    ('Content-Type', 'application/x-www-form-urlencoded'),
]

with httpx.Client(timeout=None, follow_redirects=False) as client:
    response = client.request(
        'POST',
        'http://localhost:28139/post',
        headers=headers,
        content='msg1=wow&msg2=such&msg3=@rawmsg',
    )
print(response.text)
