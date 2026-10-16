import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

/**
 * Lets a service's security group reach the database. The rule is created in the service's own
 * stack: created on the database's side, it would make the data stack depend on every service
 * stack, which already depends on it.
 */
export function allowDatabaseAccess(
  scope: Construct,
  id: string,
  database: rds.DatabaseInstance,
  from: ec2.ISecurityGroup,
  description: string,
): void {
  const [groupId] = database.connections.securityGroups.map((group) => group.securityGroupId);
  new ec2.CfnSecurityGroupIngress(scope, id, {
    groupId: groupId!,
    sourceSecurityGroupId: from.securityGroupId,
    ipProtocol: 'tcp',
    fromPort: 5432,
    toPort: 5432,
    description,
  });
}
