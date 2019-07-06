import * as grpc from 'grpc';
import { Struct, Value } from 'google-protobuf/google/protobuf/struct_pb';
import * as fs from 'fs';

import { Field, StepInterface } from './base-step';

import { ICogServiceServer } from './proto/cog_grpc_pb';
import { ManifestRequest, CogManifest, Step, RunStepRequest, RunStepResponse, FieldDefinition,
  StepDefinition } from './proto/cog_pb';
import { Connection } from 'jsforce';

export class Cog implements ICogServiceServer {

  private cogName: string = 'automatoninc/salesforce';
  private cogVersion: string = JSON.parse(fs.readFileSync('package.json').toString('utf8')).version;
  private authFields: Field[] = [{
    field: 'instanceUrl',
    type: FieldDefinition.Type.STRING,
    description: 'Your Salesforce server URL (e.g. https://na1.salesforce.com)',
  }, {
    field: 'accessToken',
    type: FieldDefinition.Type.STRING,
    description: 'Your Salesforce OAuth2 access token.',
  }];

  private steps: StepInterface[];

  constructor (private apiClient, private stepMap: any = {}) {
    // Dynamically reads the contents of the ./steps folder for step definitions and makes the
    // corresponding step classes available on this.steps and this.stepMap.
    this.steps = fs.readdirSync(`${__dirname}/steps`, { withFileTypes: true })
      .filter((file: fs.Dirent) => {
        return file.isFile() && (file.name.endsWith('.ts') || file.name.endsWith('.js'));
      }).map((file: fs.Dirent) => {
        const step = require(`${__dirname}/steps/${file.name}`).Step;
        const stepInstance: StepInterface = new step();
        this.stepMap[stepInstance.getId()] = step;
        return stepInstance;
      });

    // Used only for testing...
    if (stepMap.length > 0) {
      this.stepMap = stepMap;
    }
  }

  /**
   * Implements the cog:getManifest grpc method, responding with a manifest definition, including
   * details like the name of the cog, the version of the cog, any definitions for required
   * authentication fields, and step definitions.
   */
  getManifest(
    call: grpc.ServerUnaryCall<ManifestRequest>,
    callback: grpc.sendUnaryData<CogManifest>,
  ) {
    const manifest: CogManifest = new CogManifest();
    const stepDefinitions: StepDefinition[] = this.steps.map((step: StepInterface) => {
      return step.getDefinition();
    });

    manifest.setName(this.cogName);
    manifest.setVersion(this.cogVersion);
    manifest.setStepDefinitionsList(stepDefinitions);

    this.authFields.forEach((field: Field) => {
      const authField: FieldDefinition = new FieldDefinition();
      authField.setKey(field.field);
      authField.setOptionality(FieldDefinition.Optionality.REQUIRED);
      authField.setType(field.type);
      authField.setDescription(field.description);
      manifest.addAuthFields(authField);
    });

    callback(null, manifest);
  }

  /**
   * Implements the cog:runSteps grpc method, responding to a stream of RunStepRequests and
   * responding in kind with a stream of RunStepResponses. This method makes no guarantee that the
   * order of step responses sent corresponds at all with the order of step requests received.
   */
  runSteps(call: grpc.ServerDuplexStream<RunStepRequest, RunStepResponse>) {
    let processing = 0;
    let clientEnded = false;

    call.on('data', async (runStepRequest: RunStepRequest) => {
      processing = processing + 1;

      const step: Step = runStepRequest.getStep();
      const response: RunStepResponse = await this.dispatchStep(step, call.metadata);
      call.write(response);

      processing = processing - 1;

      // If this was the last step to process and the client has ended the stream, then end our
      // stream as well.
      if (processing === 0 && clientEnded) {
        call.end();
      }
    });

    call.on('end', () => {
      clientEnded = true;

      // Only end the stream if we are done processing all steps.
      if (processing === 0) {
        call.end();
      }
    });
  }

  /**
   * Implements the cog:runStep grpc method, responding to a single RunStepRequest with a single
   * RunStepResponse.
   */
  async runStep(
    call: grpc.ServerUnaryCall<RunStepRequest>,
    callback: grpc.sendUnaryData<RunStepResponse>,
  ) {
    const step: Step = call.request.getStep();
    const response: RunStepResponse = await this.dispatchStep(step, call.metadata);
    callback(null, response);
  }

  /**
   * Helper method to dispatch a given step to its corresponding step class and handle error
   * scenarios. Always resolves to a RunStepResponse, regardless of any underlying errors.
   */
  private async dispatchStep(step: Step, metadata: grpc.Metadata): Promise<RunStepResponse> {
    const client = this.instantiateClient(metadata);
    const stepId = step.getStepId();
    let response: RunStepResponse = new RunStepResponse();

    if (!this.stepMap.hasOwnProperty(stepId)) {
      response.setOutcome(RunStepResponse.Outcome.ERROR);
      response.setMessageFormat('Unknown step %s');
      response.addMessageArgs(Value.fromJavaScript(stepId));
      return response;
    }

    try {
      const stepExecutor: StepInterface = new this.stepMap[stepId](client);
      response = await stepExecutor.executeStep(step);
    } catch (e) {
      response.setOutcome(RunStepResponse.Outcome.ERROR);
      response.setResponseData(Struct.fromJavaScript(e));
    }

    return response;
  }

  /**
   * This is a contrived example to demonstrate what it might look like for you
   * to pass API credentials to an API client, which you could then pass into
   * your steps. Obviously a user agent is not a great example of an auth field,
   * but you get the idea.
   *
   * @see this.authFields to define alternate/real authentication fields
   */
  private instantiateClient(auth: grpc.Metadata): Connection {
    return new this.apiClient.Connection({
      instanceUrl: auth.get('instanceUrl').toString(),
      accessToken: auth.get('accessToken').toString(),
    });
  }

}
