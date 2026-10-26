## M1 · First

### M1-T01 · Alpha

- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** Build alpha.
- **Done when:** build alpha works.
### M1-T02 · Beta

- **Kind:** cli · **Size:** M · **Depends:** M1-T01
- **Do:** Build beta on alpha.
- **Done when:** build beta on alpha works.

## M2 · Second

### M2-T01 · Gamma

- **Kind:** core · **Size:** S · **Depends:** none
- **Do:** Build gamma.
- **Done when:** build gamma works.
### M2-T02 · Delta

- **Kind:** core · **Size:** S · **Depends:** M1-T02, M2-T01
- **Do:** Build delta.
- **Done when:** build delta works.
