# Backend services

The implemented deployment starts as two processes:

- `api-gateway` is the public REST API and modular backend. It owns authentication, compliance,
  fixed catalog pricing, custody, deposit/withdrawal state, the upgrader transaction, and admin audit.
- `minecraft-bot` is the isolated Mineflayer bridge. It never accepts public browser requests and
  communicates with the API through a signed, replay-protected internal protocol.

The remaining scaffold directories are reserved boundaries for a future split. They contain no
runtime implementation and should not be deployed.
