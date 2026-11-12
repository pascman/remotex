# Remotex (SFTP / FTP)

VS Code 탐색기에서 SFTP · FTP · FTPS 서버의 파일을 로컬 폴더처럼 열고 편집하는 확장입니다
(remote-fs와 같은 방식: `FileSystemProvider` 기반, 저장하면 바로 서버에 반영).

## 사용법

1. 명령 팔레트 → **Remotex: Add Remote Server...** 로 서버 추가 (사용자 설정에 저장됨)
   또는 `settings.json`에 직접 작성:

```jsonc
"remotex.remotes": {
  "my-sftp": {
    "protocol": "sftp",
    "host": "example.com",
    "port": 22,
    "username": "me",
    "privateKeyPath": "~/.ssh/id_ed25519",   // 또는 비워두면 비밀번호를 물어봄
    "rootPath": "/var/www"
  },
  "my-ftp": {
    "protocol": "ftp",
    "host": "ftp.example.com",
    "username": "me",
    "secure": true,            // false = FTP, true = 명시적 FTPS, "implicit" = 암시적 FTPS
    "rootPath": "/public_html"
  }
}
```

2. **Remotex: Connect to Remote** → 서버 선택 → 워크스페이스에 폴더로 추가됩니다.
   새 창으로 열려면 **Remotex: Open Remote in New Window**.
3. 끊기: 탐색기에서 원격 루트 폴더 우클릭 → **Disconnect Remote**.

## 설정 항목

| 키 | 설명 |
|---|---|
| `protocol` | `sftp` 또는 `ftp` |
| `host`, `port` | 기본 포트: sftp 22, ftp 21, 암시적 FTPS 990 |
| `username`, `password` | password는 비워두는 것을 권장 — 처음 접속할 때 묻고 OS 키체인(SecretStorage)에 저장 |
| `rootPath` | 워크스페이스 루트로 보여줄 원격 디렉터리 |
| `privateKeyPath`, `passphrase` | SFTP 키 인증 |
| `agent` | SFTP: `true`(SSH_AUTH_SOCK / Windows OpenSSH agent), `"pageant"`, 또는 소켓 경로 |
| `secure` | FTP: `true`(AUTH TLS) / `"implicit"` |
| `allowUnauthorizedCert` | FTPS 자체서명 인증서 허용 |
| `encoding` | FTP 파일명 인코딩 (예: `latin1`) |
| `connectTimeout` | ms, 기본 20000 |

`remotex.rememberPasswords` (기본 true)를 끄면 비밀번호를 저장하지 않습니다.
저장된 비밀번호 삭제: **Remotex: Forget Saved Password**. 로그: **Remotex: Show Log**.

## 개발

```bash
npm install
npm run build      # dist/extension.js
npm run package    # remotex-x.y.z.vsix
```

F5 (Run Extension)로 Extension Development Host에서 실행할 수 있습니다.

## 제한 사항

- 서버 쪽 변경 감시(watch)는 없습니다. 다른 곳에서 바뀐 파일은 탐색기 새로고침으로 반영하세요.
- SFTP 호스트 키 검증을 하지 않습니다(첫 접속 시 known_hosts 확인 없음).
- FTP는 연결 하나로 명령을 순차 처리하며, 디렉터리 목록을 3초간 캐시합니다.

## 라이선스

[MIT](LICENSE) © pascman
