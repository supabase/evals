---
stage: build
interface: cli
preinstallCli: true
startLocalStack: true
product:
  - auth
  - database
topic:
  - rls
  - security
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  Anonymous users reach the database as ordinary signed-in users, so every
  existing rule treats a guest like a customer until something tells them
  apart. Customers ask how a guest rule combines with the rules already on a
  table, and a guest who makes an account keeps a token that still says guest
  until it refreshes. This checks that an agent reading the Anonymous Sign-Ins
  guide keeps review writing to people with an account, including one made a
  moment ago. The prompt omits the guide's vocabulary on purpose, so read
  README.md before editing it.
---

I run a plant shop and I want people to be able to try it without signing up.
A visitor should be able to look around, read the reviews and fill a cart.
Writing a review is for people who made an account. Someone who starts as a
visitor and then makes an account should be able to write a review straight
away. Set that up in the local project, and make sure it is applied to the
local database.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/auth-anonymous.md
