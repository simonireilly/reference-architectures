import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'

// Import the pg client to run a smoke test in the `writeToDatabase` lambda
// handler code. Pulumi handles packaging this dependency using introspection.
// It will only be included in the `node_modules` of the `writeToDatabase`
// lambda.
import { Client } from 'pg'

// Config
const config = new pulumi.Config()
const databaseName = config.require('databaseName')
const masterPassword = config.requireSecret('masterPassword')
const masterUsername = config.requireSecret('masterUsername')

const tags = {
  Name: config.name,
  Environment: pulumi.getStack()
}

// Queues
//
// Define the dead letter queue first, as the normal queue has a dependency on
// the ARN
const DLQueue = new aws.sqs.Queue('webhook-DLQ', {})

// Await the dead letter queue ARN
const Queue = new aws.sqs.Queue('webhook', {
  redrivePolicy: DLQueue.arn.apply(arn => JSON.stringify({
    deadLetterTargetArn: arn,
    maxReceiveCount: 5
  })),
  visibilityTimeoutSeconds: 60,
  tags
})

// API
//
// Await the queue id (url of queue)
//
// Trigger SQS submission event lambda handler from API Gateway.
// By default pulumi uses base64 encoded messages
const api = Queue.id.apply(QueueUrl => {
  const webhookEventHandler = new aws.lambda.CallbackFunction('ingress', {
    memorySize: 128,
    runtime: 'nodejs12.x',
    timeout: 10,
    callback: async (event: { body: string }) => {
      const buff = Buffer.from(event.body || '', 'base64')
      const text = buff.toString('ascii')
      const body = JSON.parse(text)
      const MessageBody = JSON.stringify(body)

      const sqs = new aws.sdk.SQS()
      await sqs.sendMessage({ MessageBody, QueueUrl }, undefined).promise()
      return { statusCode: 200, body: MessageBody }
    }
  })

  return new awsx.apigateway.API('api', {
    routes: [{
      path: '/message',
      method: 'POST',
      eventHandler: webhookEventHandler
    }]
  })
})

// VPC
//
// Allocate a new VPC with private subnet (best practice) with the default
// number of availability zones in the region the stack was initialized in.
const stackVPC = new awsx.ec2.Vpc('stackVPC', {
  subnets: [{ type: 'private' }],
  tags
})

// Create a subnet group for the RDS Cluster
const defaultSubnetGroup = new aws.rds.SubnetGroup('default', {
  subnetIds: stackVPC.privateSubnetIds,
  tags
})

// RDS Cluster
//
// Create an RDS cluster for postgres which is inside the private subnet group
// in the new VPC.
const postgresql = new aws.rds.Cluster('postgresql', {
  backupRetentionPeriod: 5,
  clusterIdentifier: 'aurora-cluster-demo',
  engine: 'aurora-postgresql',
  engineMode: 'serverless',
  preferredBackupWindow: '07:00-09:00',
  skipFinalSnapshot: true,
  enableHttpEndpoint: true,
  databaseName,
  masterPassword,
  masterUsername,
  dbSubnetGroupName: defaultSubnetGroup.id,
  vpcSecurityGroupIds: [stackVPC.vpc.defaultSecurityGroupId],
  tags
})

// Queue events
//
// Await the Queue arn resolving and create a policy for reading messages
// from queue
const policy = Queue.arn.apply(arn => (
  new aws.iam.Policy('accessSQSQueuePolicy', {
    policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Action: [
          'sqs:ReadMessage'
        ],
        Effect: 'Allow',
        Resource: arn
      }]
    })
  })
))

// Await the Policy ARN resolving and attach it directly to the lambda
//
// Create a new lambda function triggered by messages from the SQS
// Queue. The lambda is created inside the VPC created earlier
// and given the private subnet id's so it can interact with the RDS Cluster
policy.arn.apply(arn => (
  Queue.onEvent('persist', new aws.lambda.CallbackFunction('writeToDatabase', {
    policies: [
      aws.iam.ManagedPolicies.AWSLambdaVPCAccessExecutionRole,
      aws.iam.ManagedPolicies.AWSLambdaFullAccess,
      arn
    ],
    environment: {
      variables: {
        // See the `pg` client connection string ENV vars
        PGUSER: masterUsername,
        PGHOST: postgresql.endpoint,
        PGPASSWORD: masterPassword,
        PGDATABASE: databaseName,
        PGPORT: '5432'
      }
    },
    vpcConfig: {
      subnetIds: stackVPC.privateSubnetIds,
      securityGroupIds: [stackVPC.vpc.defaultSecurityGroupId]
    },
    memorySize: 128,
    timeout: 10,
    runtime: 'nodejs12.x',
    callback: async (event, context) => {
      let res
      const client = new Client()
      try {
        await client.connect()
        res = await client.query('SELECT NOW()')
      } finally {
        console.log(res)
        console.log(event)
        console.log(context)

        // Ensure you always close the connection
        await client.end()
      }
    },
    tags
  }))
))

// Export the resulting API Gateway URL for testing
export const url = api.url
