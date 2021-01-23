import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { MaxUint256 } from '@ethersproject/constants';
import { TransactionResponse } from '@ethersproject/providers';
import { Trade, TokenAmount, ETHER, ChainId, ZERO_ADDRESS } from '@uniswap/sdk';
import { BigNumber } from '@ethersproject/bignumber';
import { useTokenAllowance } from '../data/Allowances';
import { Field } from '../state/swap/actions';
import {
  useTransactionAdder,
  useHasPendingApproval,
  useAllTransactions,
} from '../state/transactions/hooks';
import { computeSlippageAdjustedAmounts } from '../utils/prices';
import { calculateGasMargin } from '../utils';
import { useTokenContract } from './useContract';
import { useActiveWeb3React } from './index';
import { ONE_SPLIT_ADDRESSES } from '../constants/one-split';
import { AppState } from '../state';

export enum ApprovalState {
  UNKNOWN,
  NOT_APPROVED,
  PENDING,
  APPROVED,
}

// returns a variable indicating the state of the approval and a function which approves if necessary or early returns
export function useApproveCallback(
  amountToApprove?: TokenAmount,
  spender?: string,
  isPool?: boolean,
): [ApprovalState, () => Promise<void>] {
  const { account } = useActiveWeb3React();
  const token = amountToApprove instanceof TokenAmount ? amountToApprove.token : undefined;
  const allTransactions = useAllTransactions();
  const currentAllowance = useTokenAllowance(
    token?.isEther ? undefined : token,
    account ?? undefined,
    spender,
  );
  const pendingApproval = useHasPendingApproval(token?.address, spender);
  const swapState = useSelector<AppState, AppState['swap']>(state => state.swap);
  // check the current approval status
  const approvalState: ApprovalState = useMemo(() => {
    if (!amountToApprove || !spender) return ApprovalState.UNKNOWN;
    if (
      (amountToApprove.token.equals(ETHER) || swapState[Field.INPUT].currencyId === ZERO_ADDRESS) &&
      !isPool
    )
      return ApprovalState.APPROVED;
    // we might not have enough data to know whether or not we need to approve
    if (!currentAllowance) return ApprovalState.UNKNOWN;
    if (!spender) return ApprovalState.UNKNOWN;

    // amountToApprove will be defined if currentAllowance is
    return currentAllowance.lessThan(amountToApprove)
      ? pendingApproval
        ? ApprovalState.PENDING
        : ApprovalState.NOT_APPROVED
      : ApprovalState.APPROVED;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountToApprove, currentAllowance, pendingApproval, spender, allTransactions]);
  const tokenContract = useTokenContract(token?.isEther ? undefined : token?.address);
  const addTransaction = useTransactionAdder();

  const approve = useCallback(async (): Promise<void> => {
    if (approvalState !== ApprovalState.NOT_APPROVED) {
      console.error('approve was called unnecessarily');
      return;
    }
    if (!token) {
      console.error('no token');
      return;
    }
    if (!tokenContract) {
      console.error('no token');
      return;
    }

    if (!spender) {
      return;
    }

    if (!amountToApprove) {
      console.error('missing amount to approve');
      return;
    }

    if (!spender) {
      console.error('no spender');
      return;
    }

    let useExact = false;
    const estimatedGas = await tokenContract.estimateGas.approve(spender, MaxUint256).catch(() => {
      // general fallback for tokens who restrict approval amounts
      useExact = true;
      return tokenContract.estimateGas.approve(spender, amountToApprove.raw.toString());
    });

    return tokenContract
      .approve(spender, useExact ? amountToApprove.raw.toString() : MaxUint256, {
        gasLimit: calculateGasMargin(estimatedGas),
      })
      .then((response: TransactionResponse) => {
        addTransaction(response, {
          summary: 'Approve ' + amountToApprove.token.symbol,
          approval: { tokenAddress: token.address, spender: spender },
        });
      })
      .catch((error: Error) => {
        console.debug('Failed to approve token', error);
        throw error;
      });
  }, [approvalState, token, tokenContract, amountToApprove, spender, addTransaction]);

  return [approvalState, approve];
}

// wraps useApproveCallback in the context of a swap
export function useApproveCallbackFromTrade(
  trade?: Trade,
  distribution?: BigNumber[],
  allowedSlippage = 0,
) {
  const swapState = useSelector<AppState, AppState['swap']>(state => state.swap);
  const amountToApprove = useMemo(
    () => (trade ? computeSlippageAdjustedAmounts(trade, allowedSlippage)[Field.INPUT] : undefined),
    [trade, allowedSlippage],
  );
  // const tradeIsV1 = getTradeVersion(trade) === Version.v1
  // const v1ExchangeAddress = useV1TradeExchangeAddress(trade)
  let spenderAddress;
  if (trade) {
    spenderAddress =
      trade.route.path.length <= 2 &&
      (swapState[Field.INPUT].currencyId !== ZERO_ADDRESS ||
        swapState[Field.OUTPUT].currencyId !== ZERO_ADDRESS)
        ? trade?.route.pairs[0].poolAddress
        : ONE_SPLIT_ADDRESSES[ChainId.KOVAN];
  } else {
    spenderAddress = ONE_SPLIT_ADDRESSES[ChainId.KOVAN];
  }
  return useApproveCallback(amountToApprove, spenderAddress);
}
