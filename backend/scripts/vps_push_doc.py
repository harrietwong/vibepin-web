#!/usr/bin/env python3
"""Push docs/pinterest-api-architecture.md to VPS."""
import pathlib, paramiko

doc = pathlib.Path("d:/代码/Pinterest flow/docs/pinterest-api-architecture.md").read_bytes()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("47.89.181.103", port=22, username="root", password="26mXvu2iEMwb!ab", timeout=20)
sftp = client.open_sftp()
try:
    sftp.mkdir("/opt/vibepin/docs")
except OSError:
    pass
with sftp.open("/opt/vibepin/docs/pinterest-api-architecture.md", "w") as f:
    f.write(doc)
sftp.close()
print("pushed doc to VPS /opt/vibepin/docs/pinterest-api-architecture.md")
client.close()
