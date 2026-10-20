# DP-01 — Addendum 1 (Nick, 2026-10-20, while the build was in flight)

Apply this on top of `brief.md`. Where it conflicts with the brief, this addendum wins.

Nick's words: "I'm not sure how to get n SQLite files on m VMs, but control plane should have
routing logic and a vm should have an agent doing last mile things the control plane or something
outside that vm wants done to tenant data on a SQLite file in that vm" — and: "Agent being
process not ai."

## Changes to the design

1. **Topology is n SQLite files across m VMs.** The fleet is m VMs; the databases are n SQLite
   files distributed across them. Placement — which VM a new database lands on — is a
   **control-plane decision** recorded in the registry at creation time. Do NOT invent a solved
   placement mechanism: the documents should name placement policy (how the control plane picks
   a VM) as an explicit open decision of this proposal, with the registry as the source of truth
   once the decision is made.

2. **Routing logic lives in the control plane.** The control plane owns the placement registry
   AND the routing logic that resolves (tenant, database) → VM. The data plane consults it
   (a cached read is fine to show, with the control plane as authority and moves invalidating
   stale routes) — but routing authority must not sit in the data plane or the clients.

3. **Every VM runs an agent PROCESS** — a node agent daemon, software, not an AI/LLM agent;
   label it exactly that way ("VM agent (process)") so no reader mistakes it. The agent process
   is the **last mile**: it is the only component on the VM that touches tenant SQLite files,
   and everything the control plane — or anything outside the VM — wants done to tenant data in
   a file on that VM is executed by that VM's agent process on instruction. That includes:
   - data-plane work: execute statements/queries against a named database file and return
     results (this is where the landed FFI execution layer, statement lanes, classifier, and
     deadlines live — inside/behind the agent process);
   - control-plane lifecycle work: create/provision a file, open/close, suspend, snapshot and
     backup, copy a file out / receive a file in (database moves), delete a file, and report
     health, size, and usage back to the control plane.
   The control plane never reaches into a VM's disk directly; it instructs the agent process.

4. Rework the flows accordingly: **query** = ingress → control-plane routing resolves the VM →
   that VM's agent process executes locally → results return; **create database** = control
   plane picks a VM, instructs its agent process to provision the file, registry records the
   placement once the agent confirms; **move database** = source and target agent processes
   copy/fence/hand over under control-plane coordination, registry flips placement only when
   the target agent confirms; **drop** = control plane instructs the hosting VM's agent process
   to remove the file, then cleans the registry.

Record this addendum in the dataset inventory as a design source, alongside the brief.
