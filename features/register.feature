@manual
Feature: Group register
  app.certified.group.register creates a BRAND-NEW PDS account (createAccount +
  a PLC operation adding the certified_group service to the DID document + an
  app password), seeds the caller as owner, and returns the group DID, full
  handle, and account password.

  This feature is @manual — excluded from the default profile and CI — because
  it cannot be cleanly torn down: app.certified.group.destroy removes only the
  service's record of the group and explicitly leaves the PDS account intact, so
  every register run leaks a real account and DID. Run it by hand against a
  disposable PDS when you want to exercise the path. A unique handle is generated
  per run, so the first registration always succeeds; the conflict scenario then
  re-registers that same handle.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved

  Scenario: Register creates a new group account
    When the owner registers a new group with a unique handle
    Then the response status is 200
    And the register response returns the group DID and handle
    And the register response returns an account password

  Scenario: Registering the same handle again reports a conflict
    Given the owner has registered a new group with a unique handle
    When the owner registers a new group with that same handle
    Then the response status is 409
    And the response error is "HandleNotAvailable"
