Feature: Health
  The group service exposes an unauthenticated GET /health that reports
  service liveness (and database reachability). This is the only endpoint
  that does not require an atproto service-auth JWT.

  @health
  Scenario: /health reports ok
    When the CGS /health endpoint is queried
    Then the response status is 200
    And the response status field is "ok"
