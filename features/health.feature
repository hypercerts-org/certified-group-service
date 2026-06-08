Feature: Health
  The group service exposes an unauthenticated GET /health that reports
  service liveness (and database reachability), plus an /xrpc/_health alias
  that returns the same body. These are the only endpoints that do not
  require an atproto service-auth JWT.

  @health
  Scenario: /health reports ok with service and version
    When the CGS "/health" endpoint is queried
    Then the response status is 200
    And the response status field is "ok"
    And the response "service" field is "group-service"
    And the response contains a version string

  @health
  Scenario: /xrpc/_health mirrors /health
    When the CGS "/xrpc/_health" endpoint is queried
    Then the response status is 200
    And the response status field is "ok"
    And the response "service" field is "group-service"
    And the response contains a version string
