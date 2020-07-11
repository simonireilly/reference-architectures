import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'

import { Client } from 'pg'

// Config
const config = new pulumi.Config()
const databaseName = config.require('databaseName')
const masterPassword = config.requireSecret('masterPassword')
const masterUsername = config.requireSecret('masterUsername')

// Queues
//
// Define the dead letter queue first, as the normal queue has a dependency on the ARN
const DLQueue = new aws.sqs.Queue('webhook-DLQ', {})

// Await the dead letter queue ARN
const Queue = new aws.sqs.Queue('webhook', {
  redrivePolicy: DLQueue.arn.apply(arn => JSON.stringify({
    deadLetterTargetArn: arn,
    maxReceiveCount: 5
  })),
  visibilityTimeoutSeconds: 300
})

// API
//
// Await the queue id (url of queue)
//
// Trigger SQS submission event lambda handler
const api = Queue.id.apply(QueueUrl =>
  new awsx.apigateway.API('api', {
    routes: [{
      path: '/message',
      method: 'POST',
      eventHandler: async (event, context) => {
        const buff = Buffer.from(event.body || '', 'base64')
        const text = buff.toString('ascii')
        const body = JSON.parse(text)
        const MessageBody = JSON.stringify(body)

        const sqs = new aws.sdk.SQS()
        await sqs.sendMessage({ MessageBody, QueueUrl }, undefined).promise()
        return { statusCode: 200, body: MessageBody }
      }
    }]
  })
)

// VPC
//
// Allocate a new VPC with private subnet (best practice):
const stackVPC = new awsx.ec2.Vpc('stackVPC', {
  subnets: [{
    type: 'private'
  }]
})

// Export a few resulting fields to make them easy to use:
const { privateSubnetIds, vpc: { defaultSecurityGroupId } } = stackVPC

const defaultSubnetGroup = new aws.rds.SubnetGroup('default', {
  subnetIds: privateSubnetIds
})

const postgresql = new aws.rds.Cluster('postgresql', {
  backupRetentionPeriod: 5,
  clusterIdentifier: 'aurora-cluster-demo',
  engine: 'aurora-postgresql',
  engineMode: 'serverless',
  preferredBackupWindow: '07:00-09:00',
  skipFinalSnapshot: true,
  enableHttpEndpoint: true,
  // Credential configuration
  databaseName,
  masterPassword,
  masterUsername,
  // Networking
  dbSubnetGroupName: defaultSubnetGroup.id,
  vpcSecurityGroupIds: [stackVPC.vpc.defaultSecurityGroupId]
})

// Queue events
//
// Await the Queue arn resolving and create a policy for accessing it
const policy = Queue.arn.apply(arn => (
  new aws.iam.Policy('accessSQSQueuePolicy', {
    policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Action: [
          'sqs:*'
        ],
        Effect: 'Allow',
        Resource: arn
      }]
    })
  })
))

policy.arn.apply(arn => (
  Queue.onEvent('persistWithHTTP', new aws.lambda.CallbackFunction('writeToRDSInVpc', {
    policies: [
      aws.iam.ManagedPolicies.AWSLambdaVPCAccessExecutionRole,
      aws.iam.ManagedPolicies.AWSLambdaFullAccess,
      arn
    ],
    environment: {
      variables: {
        PGUSER: masterUsername,
        PGHOST: postgresql.endpoint,
        PGPASSWORD: masterPassword,
        PGDATABASE: databaseName,
        PGPORT: '5432'
      }
    },
    vpcConfig: {
      subnetIds: privateSubnetIds,
      securityGroupIds: [defaultSecurityGroupId]
    },
    runtime: 'nodejs12.x',
    callback: async (event, context) => {
      const client = new Client()
      await client.connect()
      const res = await client.query('SELECT NOW()')
      await client.end()
      console.log(res)
      console.log(event)
      console.log(context)
    }
  }))
))

// Export the resulting API Gateway URL:
export const url = api.url
