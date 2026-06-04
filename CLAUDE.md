# Toni's Jeans & Tees — project rules for Claude (READ BEFORE EDITING)

New-stock men's denim/tees catalog. Global rules: `~/.claude/CLAUDE.md`. Catalog rules:
`Website Designs/CATALOG-STANDARDS.md`. **This file lists Toni-specific LOCKED decisions that
OVERRIDE the standard. Do not revert them across sessions without Joel's explicit say-so.**

## LOCKED DECISIONS — do NOT undo

1. **Button label = "Check availability" (NOT "Enquire").** Plain everyday language per the copy
   standard. Sold-out variant stays "Sold out". The WhatsApp message body matches: *"I'd like to
   check availability of the *<Item>*…"* (not "I'd like to enquire about…"). Same for the wishlist
   drawer ("Check availability for all on WhatsApp") and the How-to-buy step. Internal identifiers
   (`enquireBody`, `wishlistEnquireAll` element id, the `.btn-card.primary` selector, the `enquire`
   GA event name if any) stay as-is — DO NOT rename them, visible text and code symbols are
   intentionally decoupled.

2. **Empty-publish guard is live on `/api/bulk`.** A POST with `{bags:[]}` is rejected unless the
   caller passes `force:true`. Don't remove this guard — it's the only thing standing between a
   stray empty payload and a wiped catalog. Per CATALOG-STANDARDS.

## Infra (Stawisystems CF account `58685495706b973821d77208248c66fc`)
- Worker `tonisjeansandtees-api`; KV `BAGS` id `80341ce6604f4a8cbc15830a7ad8de88`.
- WhatsApp fallback `254721623937` (Toni). M-Pesa Till `5347003`? — check settings.
- Shop address: Shop T03, Mithoo Business Centre, Moi Avenue, Nairobi CBD.

## Deploy
Bump the relevant `?v=` query in `index.html`/`admin.html` on CSS/JS change, then push (if GH
Actions wired) or `wrangler pages deploy . --project-name=<...> --branch=main` + `wrangler deploy`
in `worker/`.
