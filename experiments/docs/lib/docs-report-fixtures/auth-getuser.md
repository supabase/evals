# JavaScript: auth.getUser()

Gets the current user details if there is an existing session. This method performs a network request to the Supabase Auth server, so the returned value is authentic and can be used to base authorization rules on.

## Parameters

- `jwt` (Optional): Takes in an optional access token JWT. If no JWT is provided, the JWT from the current session is used.

## Examples

### Get the logged in user with the current existing session

```js
const { data: { user } } = await supabase.auth.getUser()
```

### Get the logged in user with a custom access token jwt

```js
const { data: { user } } = await supabase.auth.getUser(jwt)
```
