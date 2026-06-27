@needs-rbac-accounts @needs-cgs-admin
Feature: Admin setOwner (operator-only)

  The app.certified.group.admin.setOwner endpoint reassigns a group's owner. It
  is operator-only: authenticated with HTTP Basic auth (username "admin") against
  the service CGS_ADMIN_PASSWORD, NOT a member's service-auth JWT. This feature runs
  only when both the RBAC accounts and the CGS service admin password
  (CGS_ADMIN_PASSWORD) are configured.

  The happy-path scenario reassigns ownership to the admin account and then
  reverts it, so the group is left in its original owner-only-changed-back state.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved
    And the owner has seeded the admin and member accounts

  # --- Auth: the endpoint is gated by the service admin password, not membership ---

  Scenario: A request with no credentials is rejected
    When the admin setOwner endpoint is called with no credentials
    Then the response status is 401

  Scenario: A request with the wrong admin password is rejected
    When the admin setOwner endpoint is called with the wrong admin password
    Then the response status is 401

  # --- Functional: reassign ownership, then revert ---

  Scenario: Operator reassigns ownership to the admin and reverts it
    When the operator sets the owner to the admin account
    Then the response status is 200
    And the setOwner response owner is the admin
    And the setOwner response previousOwner is the original owner
    # Revert so the group is left as it started.
    When the operator sets the owner to the original owner account
    Then the response status is 200
    And the setOwner response owner is the original owner

  # --- Error: unknown group ---

  Scenario: Reassigning ownership of an unknown group is rejected
    When the operator sets the owner of an unknown group
    Then the response status is 404
    And the response error is "UnknownGroup"
