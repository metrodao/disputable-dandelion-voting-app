const { RULINGS } = require('@aragon/apps-agreement/test/helpers/utils/enums')
const { ONE_DAY, pct16, bigExp, bn, getEventArgument, decodeEvents } = require('@aragon/contract-helpers-test')
const { assertBn, assertRevert } = require('@aragon/contract-helpers-test/src/asserts')
const { getInstalledApp, encodeCallScript } = require('@aragon/contract-helpers-test/src/aragon-os')
const { getVoteState } = require('./helpers/voting')
const deployer = require('@aragon/apps-agreement/test/helpers/utils/deployer')(web3, artifacts)

const Voting = artifacts.require('DisputableDandelionVotingMock')
const ExecutionTarget = artifacts.require('ExecutionTarget')

const ONE_DAY_BLOCKS = ONE_DAY / 15
const ANY_ADDR = '0xffffffffffffffffffffffffffffffffffffffff'

const VOTE_STATUS = {
  ACTIVE: 0,
  PAUSED: 1,
  CANCELLED: 2,
  EXECUTED: 3
}

contract('Dandelion Voting disputable', ([_, owner, voter51, voter49]) => {
  let votingBase, agreement, voting, token, collateralToken, executionTarget, script
  let voteId, actionId

  const CONTEXT = '0xabcd'
  const MIN_QUORUM = pct16(20)
  const MIN_SUPPORT = pct16(50)
  const VOTING_DURATION_BLOCKS = ONE_DAY_BLOCKS * 5
  const BUFFER_BLOCKS = 100
  const EXECUTION_DELAY_BLOCKS = 200

  before('deploy agreement and base voting', async () => {
    votingBase = await Voting.new()
    agreement = await deployer.deployAndInitializeAgreementWrapper({ owner })
    collateralToken = await deployer.deployCollateralToken()
    await agreement.sign(voter51)
  })

  before('mint vote tokens', async () => {
    token = await deployer.deployToken({})
    await token.generateTokens(voter51, bigExp(51, 18))
    await token.generateTokens(voter49, bigExp(49, 18))
  })

  beforeEach('create voting app', async () => {
    const receipt = await deployer.dao.newAppInstance('0x1234', votingBase.address, '0x', false, { from: owner })
    voting = await Voting.at(getInstalledApp(receipt))

    const SET_AGREEMENT_ROLE = await voting.SET_AGREEMENT_ROLE()
    await deployer.acl.createPermission(agreement.address, voting.address, SET_AGREEMENT_ROLE, owner, { from: owner })

    const CREATE_VOTES_ROLE = await voting.CREATE_VOTES_ROLE()
    await deployer.acl.createPermission(ANY_ADDR, voting.address, CREATE_VOTES_ROLE, owner, { from: owner })

    const CHALLENGE_ROLE = await deployer.base.CHALLENGE_ROLE()
    await deployer.acl.createPermission(ANY_ADDR, voting.address, CHALLENGE_ROLE, owner, { from: owner })

    await voting.initialize(token.address, MIN_SUPPORT, MIN_QUORUM, VOTING_DURATION_BLOCKS, BUFFER_BLOCKS, EXECUTION_DELAY_BLOCKS, { from: owner })
    await agreement.activate({
      disputable: voting,
      collateralToken,
      actionCollateral: 0,
      challengeCollateral: 0,
      challengeDuration: 2 * ONE_DAY,
      from: owner
    })
  })

  const createVote = async ({ voter, cast = false, execute = false }) => {
    executionTarget = await ExecutionTarget.new()
    script = encodeCallScript([{
      to: executionTarget.address,
      calldata: executionTarget.contract.methods.execute().encodeABI()
    }])

    const receipt = await voting.newVote(script, CONTEXT, cast, { from: voter })
    const logs = decodeEvents(receipt, Voting.abi, 'StartVote')
    voteId = getEventArgument({ logs }, 'StartVote', 'voteId')
    actionId = (await getVoteState(voting, voteId)).actionId;

    if (execute) {
      await voting.mockAdvanceBlocks(VOTING_DURATION_BLOCKS + EXECUTION_DELAY_BLOCKS)
      await voting.executeVote(voteId)
    }
  }

  describe('newVote', () => {
    beforeEach(async () => await createVote({ voter: voter51, cast: false }))

    it('saves the agreement action data', async () => {
      const { pausedAtBlock, pauseDurationBlocks, voteStatus } = await getVoteState(voting, voteId)

      assertBn(actionId, 1, 'action ID does not match')
      assertBn(pausedAtBlock, 0, 'paused at does not match')
      assertBn(pauseDurationBlocks, 0, 'pause duration does not match')
      assertBn(voteStatus, VOTE_STATUS.ACTIVE, 'vote status does not match')
    })

    it('registers a new action in the agreement', async () => {
      const { disputable, disputableActionId, collateralRequirementId, context, closed, submitter } = await agreement.getAction(actionId)

      assertBn(disputableActionId, voteId, 'disputable ID does not match')
      assert.equal(disputable, voting.address, 'disputable address does not match')
      assertBn(collateralRequirementId, 1, 'collateral ID does not match')
      assert.equal(context, CONTEXT, 'context does not match')
      assert.equal(submitter, voter51, 'action submitter does not match')
      assert.isFalse(closed, 'action is not closed')
    })

    it('canChallenge returns true', async () => {
      assert.isTrue(await voting.canChallenge(voteId))
    })

    it('canClose returns false', async () => {
      assert.isFalse(await voting.canClose(voteId))
    })
  })

  describe('execute', () => {
    beforeEach(async () => await createVote({ voter: voter51, cast: true, execute: true }))

    it('changes the disputable state to closed', async () => {
      const { actionId: voteActionId, pausedAtBlock, pauseDurationBlocks, voteStatus } = await getVoteState(voting, voteId)

      assertBn(voteStatus, VOTE_STATUS.EXECUTED, 'vote status does not match')
      assertBn(voteActionId, actionId, 'action ID does not match')
      assertBn(pausedAtBlock, 0, 'paused at does not match')
      assertBn(pauseDurationBlocks, 0, 'pause duration does not match')
    })

    it('closes the action on the agreement and executed the vote', async () => {
      assertBn(await executionTarget.counter(), 1, 'vote was not executed')

      const { disputable, disputableActionId, collateralRequirementId, context, closed, submitter } = await agreement.getAction(actionId)

      assert.isTrue(closed, 'action is not closed')
      assertBn(disputableActionId, voteId, 'disputable ID does not match')
      assert.equal(disputable, voting.address, 'disputable address does not match')
      assertBn(collateralRequirementId, 1, 'collateral ID does not match')
      assert.equal(context, CONTEXT, 'context does not match')
      assert.equal(submitter, voter51, 'action submitter does not match')
    })

    it('canChallenge returns false', async () => {
      assert.isFalse(await voting.canChallenge(voteId))
    })

    it('canClose returns true', async () => {
      assert.isTrue(await voting.canClose(voteId))
    })
  })

  describe('challenge', () => {
    let challengeBlockNumber

    beforeEach(async () => {
      await createVote({ voter: voter51, cast: true })
      await agreement.challenge({ actionId })
      challengeBlockNumber = await voting.getBlockNumberPublic()
    })

    it('pauses the vote', async () => {
      const { actionId: voteActionId, pausedAtBlock, pauseDurationBlocks, voteStatus } = await getVoteState(voting, voteId)

      assertBn(voteStatus, VOTE_STATUS.PAUSED, 'vote status does not match')
      assertBn(voteActionId, actionId, 'action ID does not match')
      assertBn(pausedAtBlock, challengeBlockNumber, 'paused at does not match')
      assertBn(pauseDurationBlocks, 0, 'pause duration does not match')
    })

    it('does not allow a voter to vote', async () => {
      assert.isFalse(await voting.canVote(voteId, voter49), 'voter can vote')

      await assertRevert(voting.vote(voteId, false, { from: voter49 }), 'DANDELION_VOTING_CANNOT_VOTE')
    })

    it('does not allow to execute the vote', async () => {
      assert.isFalse(await voting.canExecute(voteId), 'voting can be executed')
      await assertRevert(voting.executeVote(voteId), 'DANDELION_VOTING_CANNOT_EXECUTE')

      // Vote should have passed as creator voted in favour and execution block passed
      await voting.mockAdvanceBlocks(VOTING_DURATION_BLOCKS + EXECUTION_DELAY_BLOCKS)

      assert.isFalse(await voting.canExecute(voteId), 'voting can be executed')
      await assertRevert(voting.executeVote(voteId), 'DANDELION_VOTING_CANNOT_EXECUTE')
    })

    it('marks the vote as closed', async () => {
      const { isOpen, voteStatus } = await getVoteState(voting, voteId)

      assert.isFalse(isOpen, 'vote is open')
      assert.equal(voteStatus, VOTE_STATUS.PAUSED, 'vote is not paused')
    })

    it('canChallenge returns false', async () => {
      assert.isFalse(await voting.canChallenge(voteId))
    })

    it('canClose returns false', async () => {
      // Note this function will be overlooked when an action is in the challenged state
      // but we ensure if returns false anyway
      assert.isFalse(await voting.canClose(voteId))
    })
  })

  describe('resumes', () => {
    let pauseBlockNumber, currentBlock

    beforeEach('create vote and challenge', async () => {
      await createVote({ voter: voter51, cast: false })
      await agreement.challenge({ actionId })
      pauseBlockNumber = await voting.getBlockNumberPublic()

      await voting.mockAdvanceBlocks(bn(ONE_DAY_BLOCKS))
      currentBlock = await voting.getBlockNumberPublic()
    })

    const itResumesTheVote = () => {
      it('resumes the vote', async () => {
        const expectedPauseDuration = currentBlock.sub(pauseBlockNumber)
        const { actionId: voteActionId, pausedAtBlock, pauseDurationBlocks, voteStatus } = await getVoteState(voting, voteId)

        assertBn(voteStatus, VOTE_STATUS.ACTIVE, 'vote status does not match')
        assertBn(voteActionId, actionId, 'action ID does not match')
        assertBn(pausedAtBlock, pauseBlockNumber, 'paused at does not match')
        assertBn(pauseDurationBlocks, expectedPauseDuration, 'pause duration does not match')
      })

      it('allows voter to vote and execute', async () => {
        assert.isTrue(await voting.canVote(voteId, voter51), 'voter cannot vote')
        await voting.vote(voteId, true, { from: voter51 })
        await voting.mockAdvanceBlocks(VOTING_DURATION_BLOCKS + EXECUTION_DELAY_BLOCKS)

        assert.isTrue(await voting.canExecute(voteId), 'voting cannot be executed')
        await voting.executeVote(voteId)
        assertBn(await executionTarget.counter(), 1, 'vote was not executed')

        const { closed } = await agreement.getAction(actionId)
        assert.isTrue(closed, 'action is not closed')
      })

      it('marks the vote as open', async () => {
        const { isOpen, voteStatus } = await getVoteState(voting, voteId)

        assert.isTrue(isOpen, 'vote is not open')
        assert.equal(voteStatus, VOTE_STATUS.ACTIVE, 'vote is not active')
      })

      it('does not affect the voting period', async () => {
        const voteDurationBlocks = await voting.durationBlocks()
        const beforeVoteEndBlock = voteDurationBlocks.sub(bn(4)) // 4 blocks since vote created
        await voting.mockAdvanceBlocks(beforeVoteEndBlock)

        const { isOpen: isOpenBeforeEndDate } = await getVoteState(voting, voteId)
        assert.isTrue(isOpenBeforeEndDate, 'vote is not open before end date')

        await voting.mockAdvanceBlocks(1)

        const { isOpen: isOpenAtVoteEndDate } = await getVoteState(voting, voteId)
        assert.isFalse(isOpenAtVoteEndDate, 'vote is open at end date')

        await voting.mockAdvanceBlocks(1)

        const { isOpen: isOpenAtAfterEndDate } = await getVoteState(voting, voteId)
        assert.isFalse(isOpenAtAfterEndDate, 'vote is open after end date')
      })
    }

    context('when allowed', () => {
      beforeEach('dispute and allow vote', async () => {
        await agreement.dispute({ actionId })
        await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_SUBMITTER })
      })

      it('canChallenge returns false', async () => {
        assert.isFalse(await voting.canChallenge(voteId))
      })

      it('canClose returns false', async () => {
        assert.isFalse(await voting.canClose(voteId))
      })

      itResumesTheVote()
    })

    context('when voided', () => {
      beforeEach('dispute and void vote', async () => {
        await agreement.dispute({ actionId })
        await agreement.executeRuling({ actionId, ruling: RULINGS.REFUSED })
      })

      itResumesTheVote()
    })
  })

  describe('cancelled', () => {
    let pauseBlock, currentBlock

    beforeEach('create vote and challenge', async () => {
      await createVote({ voter: voter51, cast: true })
      await agreement.challenge({ actionId })
      pauseBlock = await voting.getBlockNumberPublic()

      await voting.mockAdvanceBlocks(bn(ONE_DAY_BLOCKS))
      currentBlock = await voting.getBlockNumberPublic()
    })

    const itCancelsTheVote = () => {
      it('cancels the vote', async () => {
        const expectedPauseDuration = currentBlock.sub(pauseBlock)
        const { actionId: voteActionId, pausedAtBlock, pauseDurationBlocks, voteStatus } = await getVoteState(voting, voteId)

        assertBn(voteStatus, VOTE_STATUS.CANCELLED, 'vote status does not match')
        assertBn(voteActionId, actionId, 'action ID does not match')
        assertBn(pausedAtBlock, pauseBlock, 'paused at does not match')
        assertBn(pauseDurationBlocks, expectedPauseDuration, 'pause duration does not match')
      })

      it('does not allow a voter to vote', async () => {
        assert.isFalse(await voting.canVote(voteId, voter49), 'voter can vote')
        await assertRevert(voting.vote(voteId, false, { from: voter49 }), 'DANDELION_VOTING_CANNOT_VOTE')
      })

      it('does not allow to execute the vote', async () => {
        await voting.mockAdvanceBlocks(VOTING_DURATION_BLOCKS + EXECUTION_DELAY_BLOCKS)

        assert.isFalse(await voting.canExecute(voteId), 'voting can be executed')
        await assertRevert(voting.executeVote(voteId), 'DANDELION_VOTING_CANNOT_EXECUTE')
      })

      it('marks the vote as closed', async () => {
        const voteDurationBlocks = await voting.durationBlocks()
        const beforeVoteEndBlock = voteDurationBlocks.sub(bn(4)) // 4 blocks since vote created
        await voting.mockAdvanceBlocks(beforeVoteEndBlock)

        const { isOpen: isOpenBeforeEndDate } = await getVoteState(voting, voteId)
        assert.isFalse(isOpenBeforeEndDate, 'vote is open before end date')

        await voting.mockAdvanceBlocks(1)

        const { isOpen: isOpenAtVoteEndDate } = await getVoteState(voting, voteId)
        assert.isFalse(isOpenAtVoteEndDate, 'vote is open at end date')

        await voting.mockAdvanceBlocks(1)

        const { isOpen: isOpenAtAfterEndDate } = await getVoteState(voting, voteId)
        assert.isFalse(isOpenAtAfterEndDate, 'vote is open after end date')
      })
    }

    context('when settled', () => {
      beforeEach('settle vote', async () => {
        await agreement.settle({ actionId })
      })

      itCancelsTheVote()
    })

    context('when rejected', () => {
      beforeEach('dispute and reject vote', async () => {
        await agreement.dispute({ actionId })
        await agreement.executeRuling({ actionId, ruling: RULINGS.IN_FAVOR_OF_CHALLENGER })
      })

      itCancelsTheVote()
    })
  })
})
