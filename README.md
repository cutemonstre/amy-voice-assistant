# Amy: a push-to-talk voice assistant

Hold the orb (or the Space bar), talk, let go, and hear a spoken reply. I built it to talk to an AI hands-free while driving.

## How it works

```
mic -> 16 kHz WAV -> POST /api/turn (Worker)
   ElevenLabs Scribe v2 (speech to text, language auto-detected)
   -> Claude Sonnet (streamed, with web search and a small tool loop)
   -> sentence splitter -> ElevenLabs v4 Turbo streaming speech
 <- NDJSON stream: transcript, text deltas, tool lines, sources, PCM audio chunks
```

- Runs on Cloudflare Workers, built with TanStack Start (React 19) and Tailwind v4.
- Chats are saved as sessions in a D1 database. The Worker loads the last 20 messages for context, so the browser only sends audio and a session id.
- Memory: the model can `remember` and `forget` short facts, stored in D1 and added to the prompt each turn. Secret-looking text is refused.
- Skills: markdown files in `skills/*.md` are bundled at build time. The model loads one on demand with `load_skill`.
- Web search uses Claude's built-in search through OpenRouter.
- Measured: v4 Turbo first audio takes about 0.18 s. Routing Sonnet to Anthropic's own provider cut the first token from 1.6-4.2 s to about 1.1 s. The first spoken reply starts in 2.3-2.8 s.

## Setup

```sh
npm install
npx wrangler d1 create voice-chat      # paste the id into wrangler.jsonc
cp .dev.vars.example .dev.vars         # then fill in the keys
npm run dev                            # http://localhost:3020
```

Other scripts: `npm test` (247 tests), `npm run typecheck`, `npm run build`, `npm run deploy`, `npm run db:migrate:remote`.

## Environment variables

| name | purpose |
|---|---|
| `OPENROUTER_API_KEY` | the reply model, and fallback speech-to-text |
| `ELEVENLABS_API_KEY` | speech-to-text (Scribe v2) and spoken replies |
| `APP_TOKEN` | optional. If set, the API requires a matching `x-app-token` header. Open `/?token=<APP_TOKEN>` once per device to save it. |

Models and the voice are plain vars in `wrangler.jsonc` (`LLM_MODEL`, `STT_PROVIDER`, `ELEVENLABS_MODEL`, `ELEVENLABS_VOICE_ID`).

The mic needs HTTPS, so test on a deployed Worker or a tunnel, not a LAN address.

Built by directing AI coding agents (Claude Code), with design, review and testing by the author.

## License

MIT
