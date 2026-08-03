---
motivation: derived from deploy-functions-001-edge-function-secrets, AI-815
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - observability
---

Our weather widget currently calls WeatherAPI straight from the browser, which
leaks our API key. I want to move that behind a Supabase Edge Function called
`weather` that holds the key server-side and proxies the request.

The function should read the key from an environment variable named
`WEATHER_API_KEY`. Our key already lives in a local `.env` file at the project
root.

Deploy the function to our project so it's live, and make sure the deployed
function can actually read the key at runtime.
