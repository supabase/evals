---
stage: build
interface: cli
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
  The Anonymous Sign-Ins guide warns that anonymous users reach the database
  as ordinary signed-in users, so every existing rule treats a throwaway
  visitor like a customer until something tells them apart. The guide shows
  one way to tell them apart and says a rule of that kind has to be combined
  correctly with the rules already on the table. This checks that an agent
  reading the guide lets visitors browse and fill a cart while keeping review
  writing to people with an account. The prompt omits the guide's vocabulary on
  purpose, so read README.md before editing it.
---

I run a plant shop and I want people to be able to try it without signing up.
A visitor should be able to look around, read the reviews and fill a cart.
Writing a review is for people who made an account. Set that up in the local
project, and make sure it is applied to the local database.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/auth/auth-anonymous.md
