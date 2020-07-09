import * as aws from '@pulumi/aws'
import * as awsx from '@pulumi/awsx'

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
        await sqs.sendMessage({
          MessageBody,
          QueueUrl
        }, undefined).promise()
        return { statusCode: 200, body: MessageBody }
      }
    }]
  })
)

// Submit asynchronously from the Queue into a datastore
Queue.onEvent('persist', (event, context) => {
  console.log(event)
  console.log(context)
})

// Export the resulting API Gateway URL:
export const url = api.url
export const queueUrl = Queue.id
