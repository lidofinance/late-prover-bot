export class ExitNotEligibleOnProvableBeaconBlock extends Error {
  constructor(referenceSlotTimestamp: number, eligibleExitRequestTimestamp: number) {
    super(
      `Exit is not eligible on provable beacon block. Reference slot timestamp: ${referenceSlotTimestamp}, eligible exit request timestamp: ${eligibleExitRequestTimestamp}`,
    );
    this.name = 'ExitNotEligibleOnProvableBeaconBlock';
  }
}
