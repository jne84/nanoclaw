# Storage Management

Manage cookies, localStorage, sessionStorage, and browser storage state.

## Storage State

Save and restore complete browser state including cookies and storage.

### Save Storage State

```bash
# Save to auto-generated filename (storage-state-{timestamp}.json)
playwright-cli state-save

# Save to specific filename
playwright-cli state-save my-auth-state.json
```

### Restore Storage State

```bash
# Load storage state from file
playwright-cli state-load my-auth-state.json

# Reload page to apply cookies
playwright-cli open https://example.com
```

## Cookies

```bash
# List all cookies
playwright-cli cookie-list

# Filter by domain
playwright-cli cookie-list --domain=example.com

# Get specific cookie
playwright-cli cookie-get session_id

# Set a cookie
playwright-cli cookie-set session abc123
playwright-cli cookie-set session abc123 --domain=example.com --path=/ --httpOnly --secure --sameSite=Lax

# Cookie with expiration (Unix timestamp)
playwright-cli cookie-set remember_me token123 --expires=1735689600

# Delete a cookie
playwright-cli cookie-delete session_id

# Clear all cookies
playwright-cli cookie-clear
```

## Local Storage

```bash
# List all localStorage items
playwright-cli localstorage-list

# Get single value
playwright-cli localstorage-get token

# Set value
playwright-cli localstorage-set theme dark

# Set JSON value
playwright-cli localstorage-set user_settings '{"theme":"dark","language":"en"}'

# Delete single item
playwright-cli localstorage-delete token

# Clear all localStorage
playwright-cli localstorage-clear
```

## Session Storage

```bash
# List all sessionStorage items
playwright-cli sessionstorage-list

# Get single value
playwright-cli sessionstorage-get form_data

# Set value
playwright-cli sessionstorage-set step 3

# Delete single item
playwright-cli sessionstorage-delete step

# Clear sessionStorage
playwright-cli sessionstorage-clear
```

## Common Patterns

### Authentication State Reuse

```bash
# Step 1: Login and save state
playwright-cli open https://app.example.com/login
playwright-cli snapshot
playwright-cli fill e1 "user@example.com"
playwright-cli fill e2 "password123"
playwright-cli click e3

# Save the authenticated state
playwright-cli state-save auth.json

# Step 2: Later, restore state and skip login
playwright-cli state-load auth.json
playwright-cli open https://app.example.com/dashboard
# Already logged in!
```

## Security Notes

- Never commit storage state files containing auth tokens
- Add `*.auth-state.json` to `.gitignore`
- Delete state files after automation completes
- Use environment variables for sensitive data
