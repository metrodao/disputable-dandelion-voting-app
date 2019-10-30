pragma solidity ^0.4.24;

import "@aragon/os/contracts/acl/ACL.sol";
import "@aragon/os/contracts/kernel/Kernel.sol";
import "@aragon/os/contracts/factory/DAOFactory.sol";
import "@aragon/os/contracts/factory/EVMScriptRegistryFactory.sol";
import "@aragon/apps-shared-minime/contracts/MiniMeToken.sol";
import "../../../dandelion-voting/contracts/test/mocks/VotingMock.sol";

contract TestImports {
    constructor() public {
        // solium-disable-previous-line no-empty-blocks
    }
}