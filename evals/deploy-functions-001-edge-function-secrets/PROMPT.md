---
stage: deploy
suite: benchmark
interface: cli
hostedProject: true
projectRunning: false
services: []
product:
  - edge-functions
topic:
  - security
motivation: AI-815
---

Our weather widget currently calls WeatherAPI straight from the browser, which
leaks our API key. I want to move that behind a Supabase Edge Function called
`weather` that holds the key server-side and proxies the request.

The function should read the key from an environment variable named
`WEATHER_API_KEY`. The key is sensitive, so it must not be committed to the
repo — configure it as a Function secret on our project instead of hardcoding
it or checking it in.

Deploy the function to our project so it's live, and make sure the deployed
function can actually read the key at runtime.
