Feature: Group import and destroy
  app.certified.group.import promotes a pre-existing PDS account into a group;
  app.certified.group.destroy removes it from the service. These two methods
  also run as BeforeAll/AfterAll fixtures to establish the shared group the
  other features need — here they are the subjects under test, with explicit
  assertions on their response shapes and the conflict path.

  Import is service-level (aud = the service DID, signed by the importer, so
  iss == groupDid). Destroy is group-scoped (aud = the group DID, owner-signed).
  The BeforeAll fixture has already imported the group, so the first scenario
  asserts the tolerant/idempotent behaviour rather than a fresh import.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved

  Scenario: Importing an already-imported account reports a conflict
    When the importer imports the account as a group again
    Then the response status is 409
    And the response error is "GroupAlreadyRegistered"

  Scenario: Destroy removes the group, then it can be re-imported
    When the owner destroys the group
    Then the response status is 200
    And the destroy response returns the group DID
    When the importer imports the account as a group
    Then the response status is 200
    And the import response returns the group handle
