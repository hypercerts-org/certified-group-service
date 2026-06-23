Feature: Group repo records
  The proxied repo surface lets a group member write to the group's PDS repo
  through the service: createRecord, putRecord, uploadBlob, and deleteRecord.
  These are group-scoped (aud = the group DID). Here the owner performs them
  (owner satisfies the member-level permission these need).

  The group is established by the BeforeAll fixture, so each scenario assumes a
  live, imported group.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved

  Scenario: Owner creates a feed post
    When the owner creates a feed post in the group repo
    Then the response status is 200
    And the response contains a record URI

  Scenario: Owner puts a record at a known rkey
    When the owner puts a profile record in the group repo
    Then the response status is 200
    And the response contains a record URI

  Scenario: Owner uploads a blob
    When the owner uploads a blob to the group repo
    Then the response status is 200
    And the response contains a blob reference

  Scenario: Owner deletes a record they created
    Given the owner has created a feed post in the group repo
    When the owner deletes that record
    Then the response status is 200
