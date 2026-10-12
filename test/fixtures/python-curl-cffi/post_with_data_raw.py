from curl_cffi import requests

headers = [
    ('Content-Type', 'application/x-www-form-urlencoded'),
]

with requests.Session() as client:
    response = client.request(
        'POST',
        'http://localhost:28139/post',
        allow_redirects=False,
        timeout=None,
        headers=headers,
        content='msg1=wow&msg2=such&msg3=@rawmsg',
    )
print(response.text)
