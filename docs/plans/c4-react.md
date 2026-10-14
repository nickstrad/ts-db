# C4 SDK implementation plan — moved

The authoritative plan now lives in the standalone
[c4-sdk repository](https://github.com/nickstrad/c4-sdk/blob/plan/c4-react/docs/plans/implementation.md).

It covers the seven-type JSON-driven React SDK, the Cursor “Git at any scale” showcase, pure domain logic,
vertical slices, testing and concurrent agent work. Planning and durable knowledge belong in c4-sdk.

How the future ts-db Pages application consumes the SDK (direction from Nick, 2026-10-14 ~08:30 CDT, relayed
by Twin in `/root/fable-c4-09-direction.md`): c4-sdk is published to npm on its productionization track and
ts-db ingests it as a loaded module dependency. Until it is published, ts-db may copy the c4 React code into
one dedicated folder in this repo and build with those components; that folder must stay isolated and be
deletable wholesale so the npm module can be swapped in. The earlier approach, a reviewed copy produced by
c4-sdk's C4-09 copy tooling (reviewed SHA `7042e0b`, never on c4-sdk origin), is cancelled and that tooling is
being removed from c4-sdk. The interim folder is not built until Nick asks for it. ts-db architecture content
and copy provenance stay here. This pointer does not implement that integration or change the current
application.
