#!/usr/bin/env bash
# Prints one output of a deployed CloudFormation stack, and fails if it is missing:
#   stack-output.sh <stack name> <output key>
set -euo pipefail
stack="${1:?usage: stack-output.sh <stack name> <output key>}"
key="${2:?usage: stack-output.sh <stack name> <output key>}"
value="$(aws cloudformation describe-stacks --stack-name "$stack" \
  --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text)"
if [ -z "$value" ] || [ "$value" = "None" ]; then
  echo "stack-output.sh: $stack has no output $key" >&2
  exit 1
fi
printf '%s\n' "$value"
