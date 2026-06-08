Feature: Group targeting — legacy aud vs explicit repo (#27)
  The group a request targets can be named two ways. The NEW, correct form sets
  the JWT `aud` to the SERVICE DID and names the group with an explicit `repo`
  (querystring for queries, request body for procedures). The LEGACY form
  overloads `aud` as the group DID and sends no `repo`; it still works during the
  deprecation window but the response carries an RFC 8594 `Deprecation` header.

  Both forms are exercised here against a query (member.list) and a procedure
  (createRecord), proving backwards compatibility and the new path together.

  Background:
    Given the CGS environment is running
    And the test accounts are resolved

  # --- Query method: member.list ---

  Scenario: New path — member.list with aud=serviceDid and an explicit repo
    When the owner lists the group members with aud=service and an explicit repo
    Then the response status is 200
    And the response has no deprecation header

  Scenario: Legacy path — member.list with the aud=group overload
    When the owner lists the group members with the legacy aud overload
    Then the response status is 200
    And the response has a deprecation header

  # --- Procedure: createRecord ---

  Scenario: New path — createRecord with aud=serviceDid and repo in the body
    When the owner creates a feed post with aud=service and repo in the body
    Then the response status is 200
    And the response contains a record URI
    And the response has no deprecation header

  Scenario: Legacy path — createRecord with the aud=group overload
    When the owner creates a feed post with the legacy aud overload
    Then the response status is 200
    And the response contains a record URI
    And the response has a deprecation header

  # --- Forward-compat: service-id fragment on aud (future PDS behaviour) ---
  #
  # The supported `aud` is the SERVICE DID. Today every standard caller delivers
  # it BARE (`did:web:<host>`):
  #   - getServiceAuth's `aud` is lexicon-typed `format: did`, whose validator
  #     rejects a `#fragment` (a DID URL is not a bare DID) — so a fragment'd aud
  #     cannot be minted through it, and
  #   - the reference PDS strips the service-id fragment when proxying
  #     (atproto.com/specs/xrpc#service-proxying).
  # The bare-aud form is already proven by the "New path" scenarios above, which
  # run against the live service.
  #
  # The PDS is slated to STOP stripping the fragment (Spring 2026), after which a
  # proxied call would arrive as `aud = did:web:<host>#certified_group_service`.
  # The CGS verifier already accepts that (and rejects a foreign fragment) — see
  # the unit tests in tests/verifier.test.ts, the only level at which a fragment'd
  # aud is constructible while getServiceAuth forbids it.
  #
  # This scenario is @pending (never run by default): it documents the future
  # contract, but no standard client can mint its token yet, so it cannot pass
  # end-to-end until the PDS change lands and the harness can drive a real proxied
  # call. Unskip and implement the step when both are true.
  @pending
  Scenario: New path — member.list with aud carrying the service-id fragment
    When the owner lists the group members with aud=service#certified_group_service and an explicit repo
    Then the response status is 200
    And the response has no deprecation header
