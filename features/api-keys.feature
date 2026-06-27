Feature: API keys — member-issued, scope-limited bearer credentials (#26, #57)
  A group member mints a long-lived, scope-limited API key so a backend daemon can
  poll group data without holding that member's signing key or minting a fresh
  service-auth JWT every two minutes. The key authenticates via the X-API-Key
  header; the group is named by `repo` (the same request-level targeting the
  JWT new path uses). Members manage their own keys; owners can list and revoke
  all group keys. Keys die on next use once revoked.

  This is the platform backend-sync worked example from docs/design/api-keys.md.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved

  Scenario: Owner mints a member.list key and a backend uses it to list members
    When the owner creates an API key scoped to member.list
    Then the response status is 200
    And the response contains an API key and keyRef
    When a backend lists the group members using the API key
    Then the response status is 200
    And the response has no deprecation header

  @needs-rbac-accounts
  Scenario: Member mints a member.list key and a backend uses it to list members
    Given the owner has seeded the admin and member accounts
    When the member creates an API key scoped to member.list
    Then the response status is 200
    And the response contains an API key and keyRef
    When a backend lists the group members using the API key
    Then the response status is 200
    And the response has no deprecation header

  Scenario: A revoked key is rejected on next use
    Given the owner has created an API key scoped to member.list
    When the owner revokes the API key
    Then the response status is 200
    When a backend lists the group members using the API key
    Then the response status is 401

  @needs-rbac-accounts
  Scenario: A member can revoke their own key
    Given the owner has seeded the admin and member accounts
    And the member has created an API key scoped to member.list
    When the member revokes the API key
    Then the response status is 200
    When a backend lists the group members using the API key
    Then the response status is 401

  Scenario: An API key cannot reach an operation outside its scope
    Given the owner has created an API key scoped to member.list
    When a backend queries the audit log using the API key
    Then the response status is 403

  Scenario: keys.list never returns the key secret
    Given the owner has created an API key scoped to member.list
    When the owner lists the group API keys
    Then the response status is 200
    And the API key list does not contain any secret material

  @needs-rbac-accounts
  Scenario: Member key listings are self-scoped while owners see all keys
    Given the owner has seeded the admin and member accounts
    And the owner has created an API key scoped to member.list
    When the member creates an API key scoped to member.list
    Then the response status is 200
    When the member lists the group API keys
    Then the response status is 200
    And the API key list contains the member key but not the owner key
    When the owner lists the group API keys
    Then the response status is 200
    And the API key list contains both the member and owner keys

  Scenario: A write-scoped key can create a record via X-API-Key
    Given the owner has created an API key scoped to create feed posts
    When a backend creates a feed post using the API key
    Then the response status is 200
    And the response contains a record URI

  Scenario: A read-only key cannot create a record
    Given the owner has created an API key scoped to member.list
    When a backend creates a feed post using the API key
    Then the response status is 403
