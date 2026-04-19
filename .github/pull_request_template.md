<!--
Thanks for sending a PR! A few quick things before you open it:

- One feature or fix per PR, please.
- If this touches security-sensitive code (preload, IPC handlers, shell.openExternal,
  CSP, BrowserWindow config, GSI server binding), read SECURITY.md first.
- If this is a FACEIT-AC-relevant change, open an issue to discuss before coding.
-->

## Summary



## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Performance improvement
- [ ] UI / UX polish
- [ ] Refactor / cleanup
- [ ] Docs / CI only

## Test plan

- [ ] Built locally with `npm run build`
- [ ] Launched the packaged app (`npm run dist`) and ran through setup
- [ ] Started CS2 and verified the overlay still works (`Tab` to toggle)
- [ ] Verified your change specifically — describe what you checked:

## Screenshots (for UI changes)



## Checklist

- [ ] No API keys, Steam tokens, or other secrets in the diff
- [ ] No `console.log` of sensitive data
- [ ] No new outbound hosts added without updating the Privacy table in the README
- [ ] No new code that reads CS2 memory, injects, hooks, or captures the screen during a live match
- [ ] BrowserWindow security flags (`sandbox`, `contextIsolation`, `nodeIntegration`, `webSecurity`) not weakened
- [ ] Touched `src/main/preload.js`? Each new IPC surface has a validated input.
