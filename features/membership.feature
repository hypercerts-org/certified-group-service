@needs-rbac-accounts
Feature: RBAC across roles
  Membership and role management enforce a role hierarchy (member < admin <
  owner). This feature uses distinct pre-provisioned accounts for each role —
  admin, member, and an outsider who is not a member — so each can sign its OWN
  service-auth JWTs. That lets us assert both what each role is permitted to do
  and what it is denied (Forbidden, HTTP 403).

  The owner seeds the admin and member roles, the positive cases confirm each
  role's allowed operations, the negative cases confirm denials, and the cleanup
  returns the group to owner-only.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved
    And the owner has seeded the admin and member accounts

  # --- Positive: each role does what it is allowed ---

  Scenario: Owner lists members and sees the seeded roles
    When the owner lists the group members
    Then the response status is 200
    And the members list includes the admin and the member

  Scenario: Admin performs an admin-gated operation
    When the admin queries the audit log
    Then the response status is 200
    And the response contains audit entries

  Scenario: Member performs a member-gated operation
    When the member creates a feed post in the group repo
    Then the response status is 200
    And the response contains a record URI

  # --- Negative: denials (403 Forbidden) ---

  Scenario: Member is denied an admin-only operation
    When the member queries the audit log
    Then the response status is 403
    And the response error is "Forbidden"

  Scenario: Outsider is denied any group operation
    When the outsider lists the group members
    Then the response status is 403
    And the response error is "Forbidden"

  Scenario: Admin is denied an owner-only operation
    When the admin sets the member's role to admin
    Then the response status is 403
    And the response error is "Forbidden"

  Scenario: Admin cannot assign a role at or above its own
    When the admin adds a member with the admin role
    Then the response status is 403
    And the response error is "Forbidden"

  # --- Cleanup: return the group to owner-only ---

  Scenario: Owner removes the seeded admin and member
    When the owner removes the admin and member accounts
    Then the response status is 200
