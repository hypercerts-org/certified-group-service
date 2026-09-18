@needs-rbac-accounts
Feature: Member-initiated ownership transfer

  The app.certified.group.ownershipTransfer.* methods let an owner hand ownership
  to another member through a two-phase handshake: the owner proposes, and the
  proposed member must accept before ownership moves. Either party can cancel, and
  a .status query reports a pending transfer to the two parties only. These are
  member-facing (service-auth JWT), distinct from the operator-only admin.setOwner.

  Runs only when the RBAC test accounts (owner/admin/member/outsider) are
  configured. Scenarios that do NOT move ownership (propose, cancel, status,
  negatives) leave the group owner-only-unchanged. The one scenario that completes
  a transfer reverts it, and is additionally gated on the CGS admin password (tag
  needs-cgs-admin) so its After-hook can force-revert ownership if it fails midway.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved
    And the owner has seeded the admin and member accounts
    And there is no pending ownership transfer

  # --- propose: authorization ---

  Scenario: A non-owner cannot propose a transfer
    When the admin proposes the member as the new owner
    Then the response status is 403

  Scenario: Proposing a non-member is rejected
    When the owner proposes the outsider as the new owner
    Then the response status is 400
    And the response error is "NotAMember"

  Scenario: Proposing the current owner is rejected
    When the owner proposes the owner as the new owner
    Then the response status is 400
    And the response error is "AlreadyOwner"

  # --- propose + status + cancel (no ownership change) ---

  Scenario: An owner proposes a member and both parties can see it; ownership does not move
    When the owner proposes the admin as the new owner
    Then the response status is 200
    And the ownershipTransfer response proposedOwner is the admin
    And the ownershipTransfer response proposedBy is the owner
    # Visible to the two parties only.
    When the owner queries the ownership transfer status
    Then the response status is 200
    And the status response pending is true
    And the status response proposedOwner is the admin
    When the admin queries the ownership transfer status
    Then the response status is 200
    And the status response pending is true
    # Not visible to a non-party member: they get the same pending=false a
    # caller sees when no transfer exists, so the response cannot be used to
    # detect that one is in flight.
    When the member queries the ownership transfer status
    Then the response status is 200
    And the status response pending is false
    # Owner is still the owner — the handshake is not complete.
    And the owner is still the group owner

  Scenario: The owner can cancel a proposal they made
    When the owner proposes the admin as the new owner
    Then the response status is 200
    When the owner cancels the ownership transfer
    Then the response status is 200
    And the ownershipTransfer response cancelled is true
    When the owner queries the ownership transfer status
    Then the status response pending is false

  Scenario: The proposed owner can decline (cancel) a proposal
    When the owner proposes the admin as the new owner
    Then the response status is 200
    When the admin cancels the ownership transfer
    Then the response status is 200
    And the ownershipTransfer response cancelled is true

  # --- accept: authorization ---

  Scenario: A non-proposed member cannot accept
    When the owner proposes the admin as the new owner
    Then the response status is 200
    # Deliberately the same 404 as "nothing pending" — the refusal must not
    # disclose that a transfer exists.
    When the member accepts the ownership transfer
    Then the response status is 404
    And the response error is "NoPendingTransfer"
    And the owner is still the group owner

  Scenario: Accepting with nothing pending is rejected
    When the admin accepts the ownership transfer
    Then the response status is 404
    And the response error is "NoPendingTransfer"

  # --- accept: the full handshake completes (then revert) ---

  @needs-cgs-admin
  Scenario: The proposed owner accepts and ownership moves, then is reverted
    When the owner proposes the admin as the new owner
    Then the response status is 200
    When the admin accepts the ownership transfer
    Then the response status is 200
    And the ownershipTransfer response owner is the admin
    And the ownershipTransfer response previousOwner is the owner
    And the admin is now the group owner
    # Revert: the new owner (admin) proposes the original owner, who accepts.
    When the admin proposes the owner as the new owner
    Then the response status is 200
    When the owner accepts the ownership transfer
    Then the response status is 200
    And the owner is still the group owner
