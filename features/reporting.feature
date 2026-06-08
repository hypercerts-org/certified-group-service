Feature: Group reporting queries
  The read-side queries report on a group's history and the caller's group
  memberships: audit.query returns the group's audit log, and membership.list
  returns the groups the caller belongs to. Both are group-scoped, owner-signed
  here.

  The group is established by the BeforeAll fixture. The audit log always
  contains at least the import event from the fixture, so the audit assertion
  does not depend on other features having run first.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved

  Scenario: Owner queries the audit log
    When the owner queries the audit log
    Then the response status is 200
    And the response contains audit entries

  Scenario: Owner lists their group memberships
    When the owner lists their group memberships
    Then the response status is 200
    And the memberships include the group
