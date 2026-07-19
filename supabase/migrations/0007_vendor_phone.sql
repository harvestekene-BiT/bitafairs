-- Patch: adds a phone column to vendors, so contact info can include a
-- phone number alongside (or instead of) email.
-- Run this once in the Supabase SQL Editor on your existing project.

alter table vendors add column if not exists phone text;
