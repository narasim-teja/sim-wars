#!/usr/bin/env bash
# 04-domain.sh — associate simwars.xyz with the App Runner service and
# create the matching Route 53 records (apex ALIAS + ACM validation CNAMEs).
#
# Run AFTER nameservers at Hostinger have switched to Route 53 — App Runner
# can only validate the cert if the zone is authoritative.

source "$(dirname "$0")/env.sh"

# 1. Service ARN + service URL
SERVICE_ARN=$(aws_run apprunner list-services \
  --query "ServiceSummaryList[?ServiceName=='${APP_RUNNER_SERVICE}'].ServiceArn | [0]" \
  --output text)
if [ -z "${SERVICE_ARN}" ] || [ "${SERVICE_ARN}" = "None" ]; then
  echo "App Runner service '${APP_RUNNER_SERVICE}' not found. Run 03-deploy.sh first." >&2
  exit 1
fi

SERVICE_URL=$(aws_run apprunner describe-service \
  --service-arn "${SERVICE_ARN}" \
  --query 'Service.ServiceUrl' --output text)
echo "App Runner service URL: ${SERVICE_URL}"

# 2. Hosted zone id
ZONE_ID=$(aws_run route53 list-hosted-zones-by-name \
  --dns-name "${DOMAIN}." \
  --query "HostedZones[?Name=='${DOMAIN}.'].Id | [0]" \
  --output text)
ZONE_ID="${ZONE_ID#/hostedzone/}"
if [ -z "${ZONE_ID}" ] || [ "${ZONE_ID}" = "None" ]; then
  echo "Route 53 zone for ${DOMAIN} not found. Run 01-bootstrap.sh first." >&2
  exit 1
fi
echo "Hosted zone: ${ZONE_ID}"

# 3. Associate the custom domain with App Runner (idempotent)
echo
echo "── Associating ${DOMAIN} with App Runner ───────────────────"
ASSOC=$(aws_run apprunner describe-custom-domains \
  --service-arn "${SERVICE_ARN}" \
  --query "CustomDomains[?DomainName=='${DOMAIN}']" \
  --output json 2>/dev/null || echo "[]")

if [ "$(echo "${ASSOC}" | jq 'length')" = "0" ]; then
  aws_run apprunner associate-custom-domain \
    --service-arn "${SERVICE_ARN}" \
    --domain-name "${DOMAIN}" \
    --enable-www-subdomain >/dev/null
  echo "  association request submitted"
  sleep 8
else
  echo "  reusing existing association"
fi

# 4. Pull the validation records App Runner wants in DNS
echo
echo "── Fetching cert validation records ────────────────────────"
DOMAIN_INFO=$(aws_run apprunner describe-custom-domains \
  --service-arn "${SERVICE_ARN}" \
  --query "CustomDomains[?DomainName=='${DOMAIN}'] | [0]" \
  --output json)

echo "${DOMAIN_INFO}" | jq -r '.CertificateValidationRecords[]?
  | "  - \(.Name) \(.Type) \"\(.Value)\""' || true

# 5. Build the Route 53 ChangeBatch — apex Route 53 ALIAS (CNAME at apex is
# not permitted in DNS) + www CNAME + ACM cert validation CNAMEs.
# App Runner ALIAS target hosted zone for us-east-1: Z01915732ZBZKC8D32TPT.
APPRUNNER_HZ="${APPRUNNER_HOSTED_ZONE:-Z01915732ZBZKC8D32TPT}"
CHANGE_BATCH=$(echo "${DOMAIN_INFO}" | jq -r --arg domain "${DOMAIN}" --arg svc "${SERVICE_URL}" --arg hz "${APPRUNNER_HZ}" '
  {
    Changes: (
      [
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: $domain,
            Type: "A",
            AliasTarget: {
              HostedZoneId: $hz,
              DNSName: $svc,
              EvaluateTargetHealth: false
            }
          }
        },
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: "www." + $domain,
            Type: "CNAME",
            TTL: 300,
            ResourceRecords: [{ Value: $svc }]
          }
        }
      ] + (
        (.CertificateValidationRecords // []) | map({
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: .Name,
            Type: .Type,
            TTL: 300,
            ResourceRecords: [{ Value: .Value }]
          }
        })
      )
    )
  }')

# 6. Apply DNS changes
echo
echo "── Applying DNS records ────────────────────────────────────"
aws_run route53 change-resource-record-sets \
  --hosted-zone-id "${ZONE_ID}" \
  --change-batch "${CHANGE_BATCH}" >/dev/null
echo "  records upserted"

echo
echo "════════════════════════════════════════════════════════════"
echo "  DOMAIN ASSOCIATION SUBMITTED"
echo
echo "  Cert validation can take 15-30 min after DNS resolves."
echo "  Watch status:"
echo "    aws --profile ${AWS_PROFILE} --region ${AWS_REGION} apprunner describe-custom-domains \\"
echo "      --service-arn \"${SERVICE_ARN}\" \\"
echo "      --query 'CustomDomains[].[DomainName, Status]' --output table"
echo
echo "  Once Status=active, https://${DOMAIN} should serve the app."
echo "════════════════════════════════════════════════════════════"
