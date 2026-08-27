# Windows privacy helper

`techmap-privacy.exe` is the native boundary for data that the browser must not manage directly:

- provisions `%LOCALAPPDATA%\TechMapLive\sessions` with a protected, current-user-only DACL before first write;
- seals/unseals bounded session JSON with DPAPI CurrentUser scope and fixed application entropy;
- stores, checks, and deletes `TechMapLive/OpenAIApiKey` in Windows Credential Manager without returning the key;
- provides a synthetic self-test for ACL, DPAPI, and Credential Manager behavior.

Build and test:

```powershell
cmake -S native/privacy -B native/privacy/build -A x64
cmake --build native/privacy/build --config Release
ctest --test-dir native/privacy/build -C Release --output-on-failure
```

Run `scripts/setup-openai-key.ps1` in an interactive terminal. The native helper disables console echo while reading the key and never returns it. Never put a key in command-line arguments, environment variables, repository files, browser storage, or logs. Issue #3 connects the credential to the only permitted OpenAI request boundary.
