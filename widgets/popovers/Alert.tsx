import React, { useEffect, useId, useRef } from 'react';
import { Button } from 'widgets';
import { Intent } from 'widgets/utility';

import 'widgets/utility/utility.scss';

export interface AlertProps extends AlertActionsProps {
  open: boolean;
  title: React.ReactNode;
  icon?: JSX.Element;
  type?: Intent;
  children: React.ReactNode;
  /**
   * When false, opens the dialog with `show()` instead of `showModal()` — no top-layer
   * promotion, no ::backdrop, the rest of the page stays interactive.
   * @default true
   */
  modal?: boolean;
}

export const Alert = (props: AlertProps) => {
  const { open, onClick, title, children, icon, type, modal = true } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const alertTitleId = useId();
  const alertMessageId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null) {
      return;
    }

    const cancel = (e: Event) => e.preventDefault();
    element.addEventListener('cancel', cancel);

    return () => {
      element.removeEventListener('cancel', cancel);
    };
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (el) {
      if (open) {
        // modal=true (default): promote to the top layer with backdrop, making
        // everything behind it inert. modal=false: open in normal stacking order
        // so content behind the dialog (e.g. a <video>) stays interactive.
        modal ? el.showModal() : el.show();
      } else {
        el.close();
      }
    }
  }, [open, modal]);

  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby={alertTitleId}
      aria-describedby={alertMessageId}
      data-message-intent={type}
      data-nonmodal={modal === false ? '' : undefined}
    >
      <div className="alert-content">
        <span className="dialog-icon">{icon}</span>
        <span id={alertTitleId} className="dialog-title">
          {title}
        </span>
        <div id={alertMessageId} className="alert-message">
          {children}
        </div>
        <AlertActions
          closeButtonText={props.closeButtonText}
          secondaryButtonText={props.secondaryButtonText}
          primaryButtonText={props.primaryButtonText}
          defaultButton={props.defaultButton}
          onClick={onClick}
        />
      </div>
    </dialog>
  );
};

export enum DialogButton {
  CloseButton,
  PrimaryButton,
  SecondaryButton,
}

export interface AlertActionsProps {
  onClick: (button: DialogButton) => void;
  /**
   * @default Cancel
   */
  closeButtonText?: string;
  primaryButtonText?: string;
  secondaryButtonText?: string;
  defaultButton?: DialogButton;
}

const AlertActions = (props: AlertActionsProps) => {
  const {
    onClick,
    closeButtonText = 'Cancel',
    primaryButtonText,
    secondaryButtonText,
    defaultButton,
  } = props;

  const buttons = [];
  if (primaryButtonText !== undefined) {
    buttons.push(
      <Button
        key="primary"
        styling={defaultButton === DialogButton.PrimaryButton ? 'filled' : 'outlined'}
        text={primaryButtonText}
        onClick={() => onClick(DialogButton.PrimaryButton)}
      />,
    );
  }
  if (secondaryButtonText !== undefined) {
    buttons.push(
      <Button
        key="secondary"
        styling={defaultButton === DialogButton.SecondaryButton ? 'filled' : 'outlined'}
        text={secondaryButtonText}
        onClick={() => onClick(DialogButton.SecondaryButton)}
      />,
    );
  }
  buttons.push(
    <Button
      key="close"
      styling={defaultButton === DialogButton.CloseButton ? 'filled' : 'outlined'}
      text={closeButtonText}
      onClick={() => onClick(DialogButton.CloseButton)}
    />,
  );

  return <div className="dialog-actions">{buttons}</div>;
};
