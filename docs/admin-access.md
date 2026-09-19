# Administrator access

Public signup always creates a member. Entering an email address does not prove
ownership, and supplying a role in a signup request does not grant privileges.
Existing administrators keep the role stored on their account.

To provision another administrator, first verify the person's identity and
ownership of the existing account outside the signup flow. An authorized
operator then uses the intended database's administrative connection to update
that exact account. Bind the verified account ID and email as parameters:

```sql
update marginchat_users
set role = 'admin', updated_at = now()
where id = $1 and email = $2 and role = 'member'
returning id, email, role;
```

Confirm that exactly the intended account was returned. The new role takes
effect on the next authenticated request. Administrator access includes hosted
model usage without debiting the member wallet and access to cloud storage, so
it should be granted only to trusted operators. Do not restore an email-based
signup allowlist. This signup change does not demote previously created accounts;
review any existing administrator whose ownership was never verified.
